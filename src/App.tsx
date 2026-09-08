import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Session, User, AuthChangeEvent } from '@supabase/supabase-js';
import { supabase, logoUrl, APK_DOWNLOAD_URL } from './integrations/supabase/client';

const downloadUrl = APK_DOWNLOAD_URL;
const rewards = [{ label: 'Tier 1', rate: '5%', detail: 'Direct referrals' }, { label: 'Tier 2', rate: '0.3%', detail: 'Second level' }, { label: 'Tier 3', rate: '0.1%', detail: 'Third level' }];

// ---- Types: mirror supabase/schema.sql exactly ----
type DepositStatus = 'pending' | 'success' | 'cancelled' | 'expired';
type Deposit = { id: string; amount: number; status: DepositStatus; expires_at: string; created_at: string };
type Profile = { id: string; uid: string; phone: string | null; affiliate_id: string | null; referred_by_uid: string | null; static_avatar: string | null; balance: number; is_agent: boolean; created_at: string };
type Affiliate = { affiliate_id: string; user_id: string; name: string | null; is_agent: boolean; balance: number; referral_count: number; total_deposits: number; total_pending_deposits: number; created_at: string };
type Transaction = { id: string; user_id: string; type: 'deposit' | 'rebate' | 'payout' | 'adjustment'; amount: number; status: 'pending' | 'success' | 'failed' | 'cancelled'; note: string | null; created_at: string };
type Payout = { id: string; user_id: string; amount: number; status: 'pending' | 'approved' | 'rejected' | 'paid'; upi_id: string | null; created_at: string };

const DEPOSIT_COLS = 'id, amount, status, expires_at, created_at';
const PROFILE_COLS = 'id, uid, phone, affiliate_id, referred_by_uid, static_avatar, balance, is_agent, created_at';
const AFFILIATE_COLS = 'affiliate_id, user_id, name, is_agent, balance, referral_count, total_deposits, total_pending_deposits, created_at';

function Logo({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><img src={logoUrl} alt="HK Wallet" onError={(event) => { event.currentTarget.style.display = 'none'; }} /><span><strong>HK Wallet</strong>{!compact && <small>Earn Money Online</small>}</span></div>;
}

function Landing() {
  return <main className="landing-shell"><header className="landing-header"><Logo /><a href={downloadUrl} className="orange-button small" download>Download</a></header><section className="landing-content"><p className="eyebrow">Simple. Reliable. Rewarding.</p><h1>TO GET RUPEE<br />BY EASY TASK</h1><div className="hero-art" aria-hidden="true"><div className="hero-glow" /><div className="hero-folder"><div className="hero-paper"><b>₹</b><i /><i /><i /></div><div className="hero-cloud" /></div><div className="hero-ring" /></div><a href={downloadUrl} className="orange-button full" download>Download</a><div className="earn-label">Earn Money Online</div><div className="feature-grid"><Feature icon="◌" title="Easy task" sub="To get Rupee" /><Feature icon="↯" title="Super-fast" sub="Withdrawal" /><Feature icon="+" title="Refer" sub="And Earn" /></div><a href={downloadUrl} className="orange-button full" download>Download</a><div className="white-title">Why choose our platform?</div><div className="why-copy"><p><strong>Trusted Protection:</strong> Backed by industry-recognized partners, delivering a stable and reliable earning environment.</p><p><strong>Quick experience:</strong> Smooth task flow, easy money earning.</p><p><strong>Massive orders:</strong> Diverse tasks, suitable for both part-time and full-time work.</p></div><div className="join-banner">Join us and earn money efficiently. Safer, faster, more reliable.</div><div className="white-title">Recharge rebate</div><div className="reward-levels">{rewards.map((reward) => <div className="level-card" key={reward.label}><span>{reward.label}</span><b>{reward.rate}</b><small>{reward.detail}</small></div>)}</div></section></main>;
}

function Feature({ icon, title, sub }: { icon: string; title: string; sub: string }) { return <div className="feature"><div className="feature-icon">{icon}</div><b>{title}</b><small>{sub}</small></div>; }

function Auth({ onDone, appMode = false }: { onDone: (session: Session) => void; appMode?: boolean }) {
  const [phone, setPhone] = useState(''); const [password, setPassword] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError('');
    const result = await supabase.auth.signInWithPassword({ phone: `+91${phone.replace(/\D/g, '')}`, password });
    if (result.error) { setError(result.error.message); setLoading(false); return; }
    if (!result.data.session) { setError('Please verify your mobile number before signing in.'); setLoading(false); return; }
    onDone(result.data.session);
  }
  return <main className="auth-page"><div className="auth-card compact"><Logo compact /><h1>Login</h1><p className="auth-intro">Welcome back to your wallet</p><form onSubmit={submit}><label>Mobile<div className="phone-input"><span>+91 <em>|</em></span><input value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))} inputMode="numeric" maxLength={10} placeholder="10 digit mobile number" required /></div></label><label>Password<div className="field"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Please enter password" required minLength={6} /></div></label>{error && <div className="error-box">{error}</div>}<button className="dark-button" disabled={loading}>{loading ? 'Please wait' : 'Login'}</button></form>{!appMode && <p className="auth-switch">New to HK Wallet? <a href="/register">Register</a></p>}<button className="text-button" onClick={() => setError('Password recovery is available after account verification.')}>Forgot password</button></div></main>;
}

function AppShell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [tab, setTab] = useState<'home' | 'deposit' | 'partners' | 'admin'>('home'); const [profile, setProfile] = useState<Profile | null>(null); const [deposits, setDeposits] = useState<Deposit[]>([]); const [isAdmin, setIsAdmin] = useState(false); const [amount, setAmount] = useState(''); const [toast, setToast] = useState(''); const [payment, setPayment] = useState<Deposit | null>(null); const [now, setNow] = useState(Date.now());
  async function load() {
    const [profileResult, depositsResult, adminResult] = await Promise.all([
      supabase.from('profiles').select(PROFILE_COLS).eq('id', user.id).maybeSingle(),
      supabase.from('deposits').select(DEPOSIT_COLS).eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.rpc('is_admin'),
    ]);
    if (profileResult.data) setProfile(profileResult.data as Profile);
    if (depositsResult.error) setToast(depositsResult.error.message); else setDeposits((depositsResult.data ?? []) as Deposit[]);
    setIsAdmin(Boolean(adminResult.data));
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [user.id]);
  const active = useMemo(() => deposits.find((deposit) => deposit.status === 'pending'), [deposits]);
  useEffect(() => { if (!active || now <= new Date(active.expires_at).getTime()) return; void supabase.from('deposits').update({ status: 'expired' }).eq('id', active.id).then((result) => { if (!result.error) void load(); }); }, [now, active]);
  function timeLeft(deposit: Deposit): string { const seconds = Math.max(0, Math.floor((new Date(deposit.expires_at).getTime() - now) / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
  async function createDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setToast('Enter a valid amount.'); return; }
    const result = await supabase.from('deposits').insert({ user_id: user.id, amount: value, status: 'pending', expires_at: new Date(Date.now() + 600000).toISOString() }).select(DEPOSIT_COLS).maybeSingle();
    if (result.error) { setToast(result.error.message); return; }
    setAmount(''); await load(); if (result.data) setPayment(result.data as Deposit);
  }
  async function cancelDeposit() { if (!payment) return; const result = await supabase.from('deposits').update({ status: 'cancelled' }).eq('id', payment.id); if (result.error) setToast(result.error.message); else { setPayment(null); await load(); } }
  function requestCancel() { if (window.confirm('Do you want to cancel this transaction?')) void cancelDeposit(); }
  const balance = Number(profile?.balance ?? 0).toFixed(2);
  return <main className="app-page"><header className="app-header"><Logo compact /><button className="signout" onClick={onSignOut}>Sign out</button></header>{toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}{active && <div className="active-banner"><div><strong>You have an active request of ₹{active.amount}</strong><span>Expires in {timeLeft(active)}</span></div><button onClick={() => setPayment(active)}>Return to payment</button></div>}<section className="app-content">{tab === 'home' && <><div className="welcome"><div><p className="eyebrow">Your wallet</p><h1>Good to see you.</h1><p>Complete simple tasks and grow your rewards.</p></div><div className="avatar"><img src={profile?.static_avatar || logoUrl} alt="Profile" onError={(event) => { event.currentTarget.style.display = 'none'; }} /></div></div><div className="balance-card"><span>Available balance</span><strong>₹{balance}</strong><small>UID {profile?.uid ?? '—'}</small></div><div className="quick-grid"><button onClick={() => setTab('deposit')}><b>Make a deposit</b><small>Start a new request</small></button><button onClick={() => setTab('partners')}><b>Partner rewards</b><small>Earn up to 5%</small></button></div><div className="section-heading"><h2>Recent requests</h2><button onClick={() => setTab('deposit')}>View all</button></div>{deposits.length === 0 ? <div className="empty-card">Your deposit activity will appear here.</div> : deposits.slice(0, 3).map((deposit) => <div className="history-row" key={deposit.id}><div><b>₹{deposit.amount}</b><small>{new Date(deposit.created_at).toLocaleDateString()}</small></div><span className={`status ${deposit.status}`}>{deposit.status}</span></div>)}</>}{tab === 'deposit' && <DepositView amount={amount} setAmount={setAmount} onSubmit={createDeposit} onBack={() => setTab('home')} />}{tab === 'partners' && <PartnersView profile={profile} onBack={() => setTab('home')} />}{tab === 'admin' && <AdminView onBack={() => setTab('home')} />}</section><nav className="bottom-nav"><button className={tab === 'home' ? 'selected' : ''} onClick={() => setTab('home')}>Home</button><button className={tab === 'deposit' ? 'selected' : ''} onClick={() => setTab('deposit')}>Deposit</button><button className={tab === 'partners' ? 'selected' : ''} onClick={() => setTab('partners')}>Partners</button>{isAdmin && <button className={tab === 'admin' ? 'selected' : ''} onClick={() => setTab('admin')}>Admin</button>}</nav>{payment && <div className="modal-backdrop"><div className="payment-modal"><button className="close-button" onClick={requestCancel}>×</button><p className="eyebrow">Payment details</p><h2>Deposit request</h2><strong className="payment-amount">₹{payment.amount}</strong><p>Your request is active for <b>{timeLeft(payment)}</b>. Complete the payment before the timer ends.</p><button className="dark-button" onClick={requestCancel}>Cancel transaction</button></div></div>}</main>;
}

function DepositView({ amount, setAmount, onSubmit, onBack }: { amount: string; setAmount: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onBack: () => void }) { return <div className="view"><button className="back-link" onClick={onBack}>← Back</button><p className="eyebrow">New request</p><h1>Make a deposit</h1><p className="view-copy">Create a payment request with a ten-minute completion window.</p><form className="deposit-form" onSubmit={onSubmit}><label>Amount<div className="amount-field"><span>₹</span><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" required /></div></label><div className="amount-presets">{['500', '1000', '2500'].map((value) => <button type="button" key={value} onClick={() => setAmount(value)}>₹{value}</button>)}</div><button className="dark-button">Continue to payment</button></form></div>; }

function PartnersView({ profile, onBack }: { profile: Profile | null; onBack: () => void }) {
  const code = profile?.affiliate_id ?? profile?.uid ?? '';
  const link = typeof window === 'undefined' ? '' : `${window.location.origin}/register?ref=${code}`;
  return <div className="view"><button className="back-link" onClick={onBack}>← Back</button><p className="eyebrow">Partner rewards</p><h1>Grow together.</h1><p className="view-copy">Share your referral code and earn from three levels of successful deposits.</p><div className="partner-metric"><span>Direct reward</span><strong>5%</strong><small>Reward on every Tier 1 deposit</small></div><div className="tier-list">{rewards.map((reward) => <div className="tier-row" key={reward.label}><div><b>{reward.label}</b><small>{reward.detail}</small></div><strong>{reward.rate}</strong></div>)}</div><div className="share-card"><span>Your referral code</span><strong>{code || '—'}</strong><button onClick={() => navigator.clipboard?.writeText(link || code)}>Copy invite link</button></div></div>;
}

function AdminView({ onBack }: { onBack: () => void }) {
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]); const [payouts, setPayouts] = useState<Payout[]>([]); const [transactions, setTransactions] = useState<Transaction[]>([]); const [error, setError] = useState('');
  async function load() {
    const [a, p, t] = await Promise.all([
      supabase.from('affiliates').select(AFFILIATE_COLS).order('total_deposits', { ascending: false }),
      supabase.from('payouts').select('id, user_id, amount, status, upi_id, created_at').eq('status', 'pending').order('created_at', { ascending: false }),
      supabase.from('transactions').select('id, user_id, type, amount, status, note, created_at').order('created_at', { ascending: false }).limit(20),
    ]);
    const firstError = a.error ?? p.error ?? t.error; if (firstError) setError(firstError.message);
    setAffiliates((a.data ?? []) as Affiliate[]); setPayouts((p.data ?? []) as Payout[]); setTransactions((t.data ?? []) as Transaction[]);
  }
  useEffect(() => { void load(); }, []);
  async function processPayout(id: string, approve: boolean) { const result = await supabase.rpc('process_payout', { p_payout_id: id, p_approve: approve }); if (result.error) setError(result.error.message); else await load(); }
  async function toggleAgent(userId: string, isAgent: boolean) { const result = await supabase.from('profiles').update({ is_agent: !isAgent }).eq('id', userId); if (result.error) setError(result.error.message); else await load(); }
  return <div className="view"><button className="back-link" onClick={onBack}>← Back</button><p className="eyebrow">Admin view</p><h1>Manage partners.</h1><p className="view-copy">Review partner performance, agents, payouts and the active reward structure.</p>{error && <div className="error-box">{error}</div>}<div className="admin-grid"><div><span>Tier 1</span><b>5%</b></div><div><span>Tier 2</span><b>0.3%</b></div><div><span>Tier 3</span><b>0.1%</b></div></div><div className="section-heading"><h2>Pending payouts</h2><span>{payouts.length} total</span></div>{payouts.length === 0 ? <div className="empty-card">No pending payouts.</div> : payouts.map((payout) => <div className="history-row" key={payout.id}><div><b>₹{payout.amount}</b><small>{payout.upi_id ?? 'No UPI ID'}</small></div><span><button onClick={() => void processPayout(payout.id, true)}>Approve</button> <button onClick={() => void processPayout(payout.id, false)}>Reject</button></span></div>)}<div className="section-heading"><h2>Users & agents</h2><span>{affiliates.length} total</span></div>{affiliates.length === 0 ? <div className="empty-card">No partner records have been added yet.</div> : affiliates.map((affiliate) => <div className="history-row" key={affiliate.affiliate_id}><div><b>{affiliate.name || affiliate.affiliate_id}</b><small>{affiliate.referral_count} referrals · {affiliate.total_pending_deposits} pending · {affiliate.is_agent ? 'Agent' : 'User'}</small></div><span>₹{affiliate.total_deposits} <button onClick={() => void toggleAgent(affiliate.user_id, affiliate.is_agent)}>{affiliate.is_agent ? 'Remove agent' : 'Make agent'}</button></span></div>)}<div className="section-heading"><h2>Recent transactions</h2><span>{transactions.length}</span></div>{transactions.map((tx) => <div className="history-row" key={tx.id}><div><b>{tx.type}</b><small>{new Date(tx.created_at).toLocaleString()}</small></div><span className={`status ${tx.status}`}>₹{tx.amount}</span></div>)}</div>;
}

function isAppMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  if (mode === 'app') { try { window.localStorage.setItem('hk_mode', 'app'); } catch { /* ignore */ } return true; }
  if (mode === 'web') { try { window.localStorage.removeItem('hk_mode'); } catch { /* ignore */ } return false; }
  try { if (window.localStorage.getItem('hk_mode') === 'app') return true; } catch { /* ignore */ }
  const anyWindow = window as unknown as { Capacitor?: unknown; ReactNativeWebView?: unknown; AndroidBridge?: unknown };
  if (anyWindow.Capacitor || anyWindow.ReactNativeWebView || anyWindow.AndroidBridge) return true;
  return /HKWallet|; wv\)|WebView/i.test(window.navigator.userAgent);
}

function AppOnlyNotice() {
  return <main className="auth-page"><div className="auth-card compact"><Logo compact /><h1>Invite only</h1><p className="auth-intro">Registration is invite-only. Please register on the website via a referral link.</p><a className="dark-button" href="/login" style={{ display: 'block', textAlign: 'center' }}>Go to login</a></div></main>;
}

function Register({ lockedRef }: { lockedRef: string }) {
  const [phone, setPhone] = useState(''); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [referral, setReferral] = useState(lockedRef); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const locked = Boolean(lockedRef);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const code = referral.trim().toUpperCase(); const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) { setError('Enter a valid 10 digit mobile number.'); return; }
    if (!code) { setError('A referral code is required to register.'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    // The handle_new_user trigger reads `referred_by_uid` from metadata and creates the profile row.
    const result = await supabase.auth.signUp({ phone: `+91${digits}`, password, options: { data: { referred_by_uid: code, static_avatar: logoUrl } } });
    if (result.error) { setError(result.error.message); setLoading(false); return; }
    if (result.data.session) await supabase.auth.signOut();
    window.location.replace('/download');
  }
  return <main className="auth-page"><div className="auth-card compact"><Logo compact /><h1>Create account</h1><p className="auth-intro">Register with a referral code, then download the app.</p><form onSubmit={submit}><label>Mobile number<div className="phone-input"><span>+91 <em>|</em></span><input value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))} inputMode="numeric" maxLength={10} placeholder="10 digit mobile number" required /></div></label><label>Password<div className="field"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" required minLength={6} /></div></label><label>Confirm Password<div className="field"><input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="Re-enter password" required minLength={6} /></div></label><label>Referral Code<div className="field"><input value={referral} onChange={(event) => setReferral(event.target.value.toUpperCase())} placeholder="Enter referral code" required readOnly={locked} disabled={locked} /></div>{locked && <small className="hint">Applied from your invite link</small>}</label>{error && <div className="error-box">{error}</div>}<button className="dark-button" disabled={loading}>{loading ? 'Please wait' : 'Register'}</button></form><p className="auth-switch">Already have an account? <a href="/login">Login</a></p></div></main>;
}

function Download() {
  const items = [{ icon: '◌', title: 'Easy tasks', sub: 'Earn every day' }, { icon: '↯', title: 'Fast withdrawals', sub: 'Instant UPI payouts' }, { icon: '+', title: 'Refer & earn', sub: 'Up to 5% rewards' }];
  return <main className="landing-shell"><header className="landing-header"><Logo /><a href={downloadUrl} className="orange-button small" download>Get APK</a></header><section className="landing-content"><p className="eyebrow">Registration complete</p><h1>DOWNLOAD<br />HK WALLET APP</h1><p className="download-copy">Your account is ready. Install the app to log in, complete tasks and withdraw your earnings.</p><a href={downloadUrl} className="orange-button full" download>Download App (APK)</a><div className="feature-grid">{items.map((item) => <Feature key={item.title} icon={item.icon} title={item.title} sub={item.sub} />)}</div><div className="white-title">Why the app?</div><div className="why-copy"><p><strong>Everything in one place:</strong> wallet balance, deposits and rewards.</p><p><strong>Instant alerts:</strong> know the moment a payout lands.</p><p><strong>Secure sign-in:</strong> your account stays protected on your device.</p></div><div className="join-banner">Install the APK, sign in and start earning today.</div><a href={downloadUrl} className="orange-button full" download>Download App (APK)</a></section></main>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => { void supabase.auth.getSession().then(({ data }) => setSession(data.session)); const { data } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, currentSession: Session | null) => setSession(currentSession)); return () => data.subscription.unsubscribe(); }, []);
  const path = window.location.pathname;
  const refParam = new URLSearchParams(window.location.search).get('ref') ?? '';
  const appMode = isAppMode();
  if (appMode) {
    if (session) return <AppShell user={session.user} onSignOut={() => void supabase.auth.signOut()} />;
    if (path === '/register' || path.startsWith('/register/')) return <AppOnlyNotice />;
    return <Auth onDone={setSession} appMode />;
  }
  if (path === '/download') return <Download />;
  if (path === '/register' || path.startsWith('/register/')) return <Register lockedRef={(refParam || path.replace('/register/', '')).toUpperCase()} />;
  if (session) return <AppShell user={session.user} onSignOut={() => void supabase.auth.signOut()} />;
  if (path === '/login') return <Auth onDone={setSession} />;
  return <Landing />;
}
