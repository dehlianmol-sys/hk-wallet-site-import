-- =====================================================================
-- HK Wallet — Unified production schema
-- Run once in the Supabase SQL editor. Idempotent where practical.
-- Matches src/App.tsx exactly: profiles, deposits, transactions,
-- payouts, user_roles, affiliates (view), is_admin(), process_payout().
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Enums ----------
do $$ begin create type public.app_role as enum ('admin', 'moderator', 'user'); exception when duplicate_object then null; end $$;
do $$ begin create type public.deposit_status as enum ('pending', 'success', 'cancelled', 'expired'); exception when duplicate_object then null; end $$;
do $$ begin create type public.transaction_type as enum ('deposit', 'rebate', 'payout', 'adjustment'); exception when duplicate_object then null; end $$;
do $$ begin create type public.transaction_status as enum ('pending', 'success', 'failed', 'cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.payout_status as enum ('pending', 'approved', 'rejected', 'paid'); exception when duplicate_object then null; end $$;

-- ---------- Tables ----------
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  uid             text not null unique,                 -- 8-digit public user id
  phone           text,
  affiliate_id    text unique,                          -- referral code shared with others
  referred_by_uid text,                                 -- affiliate_id / uid of the referrer
  static_avatar   text,
  balance         numeric(14,2) not null default 0,
  is_agent        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists profiles_referred_by_uid_idx on public.profiles(referred_by_uid);

create table if not exists public.user_roles (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role    public.app_role not null,
  unique (user_id, role)
);

create table if not exists public.deposits (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  amount     numeric(14,2) not null check (amount > 0),
  status     public.deposit_status not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deposits_user_id_idx on public.deposits(user_id, created_at desc);

create table if not exists public.transactions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       public.transaction_type not null,
  amount     numeric(14,2) not null,
  status     public.transaction_status not null default 'success',
  note       text,
  ref_id     uuid,                                      -- deposit / payout id that produced it
  created_at timestamptz not null default now()
);
create index if not exists transactions_user_id_idx on public.transactions(user_id, created_at desc);

create table if not exists public.payouts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  amount     numeric(14,2) not null check (amount > 0),
  status     public.payout_status not null default 'pending',
  upi_id     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Grants (PostgREST needs explicit grants) ----------
grant select, insert, update on public.profiles     to authenticated;
grant select                 on public.user_roles   to authenticated;
grant select, insert, update on public.deposits     to authenticated;
grant select                 on public.transactions to authenticated;
grant select, insert         on public.payouts      to authenticated;
grant all on public.profiles, public.user_roles, public.deposits, public.transactions, public.payouts to service_role;

-- ---------- Helper functions ----------
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(auth.uid(), 'admin')
$$;
grant execute on function public.is_admin() to authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists deposits_touch on public.deposits;
create trigger deposits_touch before update on public.deposits for each row execute function public.touch_updated_at();
drop trigger if exists payouts_touch on public.payouts;
create trigger payouts_touch before update on public.payouts for each row execute function public.touch_updated_at();

-- ---------- Auto profile + referral on sign-up ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid text;
  v_ref text := upper(nullif(trim(coalesce(new.raw_user_meta_data->>'referred_by_uid', new.raw_user_meta_data->>'referral_code', new.raw_user_meta_data->>'referred_by')), ''));
begin
  loop
    v_uid := lpad((floor(random() * 90000000) + 10000000)::bigint::text, 8, '0');
    exit when not exists (select 1 from public.profiles where uid = v_uid);
  end loop;
  -- Only keep a referrer that really exists (by affiliate_id or uid).
  if v_ref is not null and not exists (select 1 from public.profiles p where p.affiliate_id = v_ref or p.uid = v_ref) then
    v_ref := null;
  end if;
  insert into public.profiles (id, uid, phone, affiliate_id, referred_by_uid, static_avatar)
  values (new.id, v_uid, new.phone, 'HK' || v_uid, v_ref, new.raw_user_meta_data->>'static_avatar')
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'user') on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- Deposit success → 3-tier rebate + transactions ----------
create or replace function public.handle_deposit_success()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ref   text;
  v_level int := 1;
  v_rates numeric[] := array[0.05, 0.003, 0.001];
  v_up    public.profiles%rowtype;
  v_amt   numeric(14,2);
begin
  if new.status <> 'success' or old.status = 'success' then return new; end if;

  update public.profiles set balance = balance + new.amount where id = new.user_id;
  insert into public.transactions (user_id, type, amount, status, note, ref_id)
  values (new.user_id, 'deposit', new.amount, 'success', 'Deposit credited', new.id);

  select referred_by_uid into v_ref from public.profiles where id = new.user_id;
  while v_ref is not null and v_level <= 3 loop
    select * into v_up from public.profiles where affiliate_id = v_ref or uid = v_ref limit 1;
    exit when not found;
    v_amt := round(new.amount * v_rates[v_level], 2);
    if v_amt > 0 then
      update public.profiles set balance = balance + v_amt where id = v_up.id;
      insert into public.transactions (user_id, type, amount, status, note, ref_id)
      values (v_up.id, 'rebate', v_amt, 'success', 'Tier ' || v_level || ' rebate', new.id);
    end if;
    v_ref := v_up.referred_by_uid;
    v_level := v_level + 1;
  end loop;
  return new;
end $$;

drop trigger if exists on_deposit_success on public.deposits;
create trigger on_deposit_success after update of status on public.deposits for each row execute function public.handle_deposit_success();

-- ---------- Payout processing (admin only) ----------
create or replace function public.process_payout(p_payout_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_p public.payouts%rowtype;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  select * into v_p from public.payouts where id = p_payout_id and status = 'pending' for update;
  if not found then raise exception 'Payout not pending'; end if;
  if p_approve then
    if (select balance from public.profiles where id = v_p.user_id) < v_p.amount then raise exception 'Insufficient balance'; end if;
    update public.profiles set balance = balance - v_p.amount where id = v_p.user_id;
    update public.payouts set status = 'paid' where id = p_payout_id;
    insert into public.transactions (user_id, type, amount, status, note, ref_id) values (v_p.user_id, 'payout', -v_p.amount, 'success', 'Payout approved', p_payout_id);
  else
    update public.payouts set status = 'rejected' where id = p_payout_id;
    insert into public.transactions (user_id, type, amount, status, note, ref_id) values (v_p.user_id, 'payout', 0, 'cancelled', 'Payout rejected', p_payout_id);
  end if;
end $$;
grant execute on function public.process_payout(uuid, boolean) to authenticated;

-- ---------- Admin "affiliates" view (users + agents) ----------
create or replace view public.affiliates with (security_invoker = true) as
select
  p.affiliate_id,
  p.id                                                            as user_id,
  coalesce(p.phone, p.uid)                                        as name,
  p.is_agent,
  p.balance,
  (select count(*) from public.profiles r where r.referred_by_uid in (p.affiliate_id, p.uid)) as referral_count,
  coalesce((select sum(d.amount) from public.deposits d where d.user_id = p.id and d.status = 'success'), 0) as total_deposits,
  coalesce((select count(*)      from public.deposits d where d.user_id = p.id and d.status = 'pending'), 0) as total_pending_deposits,
  p.created_at
from public.profiles p;
grant select on public.affiliates to authenticated;

-- ---------- RLS ----------
alter table public.profiles     enable row level security;
alter table public.user_roles   enable row level security;
alter table public.deposits     enable row level security;
alter table public.transactions enable row level security;
alter table public.payouts      enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles for select to authenticated using (auth.uid() = id or public.is_admin());
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id and balance = (select balance from public.profiles where id = auth.uid()) and is_agent = (select is_agent from public.profiles where id = auth.uid()));
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "user_roles_select_own" on public.user_roles;
create policy "user_roles_select_own" on public.user_roles for select to authenticated using (auth.uid() = user_id or public.is_admin());

drop policy if exists "deposits_select_own_or_admin" on public.deposits;
create policy "deposits_select_own_or_admin" on public.deposits for select to authenticated using (auth.uid() = user_id or public.is_admin());
drop policy if exists "deposits_insert_own" on public.deposits;
create policy "deposits_insert_own" on public.deposits for insert to authenticated with check (auth.uid() = user_id and status = 'pending');
drop policy if exists "deposits_update_own_cancel" on public.deposits;
create policy "deposits_update_own_cancel" on public.deposits for update to authenticated using (auth.uid() = user_id and status = 'pending') with check (auth.uid() = user_id and status in ('cancelled', 'expired'));
drop policy if exists "deposits_update_admin" on public.deposits;
create policy "deposits_update_admin" on public.deposits for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "transactions_select_own_or_admin" on public.transactions;
create policy "transactions_select_own_or_admin" on public.transactions for select to authenticated using (auth.uid() = user_id or public.is_admin());

drop policy if exists "payouts_select_own_or_admin" on public.payouts;
create policy "payouts_select_own_or_admin" on public.payouts for select to authenticated using (auth.uid() = user_id or public.is_admin());
drop policy if exists "payouts_insert_own" on public.payouts;
create policy "payouts_insert_own" on public.payouts for insert to authenticated with check (auth.uid() = user_id and status = 'pending');

-- ---------- Storage: public logo bucket `logs` ----------
insert into storage.buckets (id, name, public) values ('logs', 'logs', true) on conflict (id) do update set public = true;
drop policy if exists "logs_public_read" on storage.objects;
create policy "logs_public_read" on storage.objects for select to public using (bucket_id = 'logs');

-- ---------- Make yourself admin (replace the phone) ----------
-- insert into public.user_roles (user_id, role)
-- select id, 'admin' from auth.users where phone = '919999999999' on conflict do nothing;
