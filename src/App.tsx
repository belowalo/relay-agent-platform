import { useState, useEffect, useCallback, Component, type ReactNode, lazy, Suspense } from 'react';
import {
  LayoutDashboard,
  Layers,
  Workflow,
  Bot,
  BookOpen,
  Plug,
  Zap,
  History,
  Users,
  Settings,
  Search,
  Plus,
  Command,
  ChevronDown,
  ArrowUpRight,
  Sun,
  Moon,
  PanelLeftClose,
  Globe,
  LogOut,
  Check,
  ArrowRight,
  Network,
  Sparkles,
  ClipboardCheck,
  BookText,
  Activity,
} from 'lucide-react';
import { api, type PageProps } from './api';
import { Evaluations, Prompts, Operations } from './quality';
import { Button, Modal, Field, Loading, Badge, Select } from './ui';
import {
  Dashboard,
  Workflows,
  Projects,
  Agents,
  Knowledge,
  Tools,
  Connections,
  RunHistory,
  Applications,
  Team,
  WorkspaceSettings,
  PublishedChat,
} from './pages';
const Builder = lazy(() => import('./Builder'));
const nav = [
  { id: 'dashboard', name: 'Overview', icon: LayoutDashboard },
  { id: 'projects', name: 'Projects', icon: Layers },
  { id: 'workflows', name: 'Workflows', icon: Workflow },
  { id: 'agents', name: 'Agent library', icon: Bot },
  { id: 'knowledge', name: 'Knowledge', icon: BookOpen },
  { id: 'tools', name: 'Tools & integrations', icon: Plug },
  { id: 'connections', name: 'Model connections', icon: Zap },
  { id: 'history', name: 'Run history', icon: History },
  { id: 'applications', name: 'Applications', icon: Globe },
  { id: 'evaluations', name: 'Evaluations', icon: ClipboardCheck },
  { id: 'prompts', name: 'Prompt library', icon: BookText },
  { id: 'operations', name: 'Operations', icon: Activity },
  { id: 'team', name: 'Team', icon: Users },
  { id: 'settings', name: 'Settings', icon: Settings },
];
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h2>This view couldn’t load</h2>
        <p>{this.state.error}</p>
        <Button onClick={() => location.reload()}>Reload application</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Auth({ onComplete, notify }: { onComplete: () => void; notify: PageProps['notify'] }) {
  const [register, setRegister] = useState(true),
    [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState(
      new URLSearchParams(location.search).get('challenge') || '',
    ),
    [reset, setReset] = useState(new URLSearchParams(location.search).get('reset') || ''),
    [recover, setRecover] = useState(false),
    [options, setOptions] = useState<any>({});
  useEffect(() => {
    api('/api/auth/options')
      .then(setOptions)
      .catch(() => {});
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (recover) {
        await api('/api/auth/reset/request', form);
        notify('If the account exists, a recovery link will be sent.');
        setRecover(false);
        return;
      }
      if (reset) {
        await api('/api/auth/reset/complete', { token: reset, password: form.password });
        setReset('');
        setRegister(false);
        history.replaceState({}, '', location.pathname);
        notify('Password reset. Sign in with your new password.');
        return;
      }
      const r = await api(
        challenge ? '/api/auth/mfa' : `/api/auth/${register ? 'register' : 'login'}`,
        challenge ? { challenge, code: form.code } : form,
      );
      if (r.mfaRequired) {
        setChallenge(r.challenge);
        return;
      }
      if (challenge) history.replaceState({}, '', location.pathname);
      onComplete();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-screen">
      <div className="auth-art">
        <a className="brand" href="/">
          <span className="brand-symbol">
            <Network size={23} />
          </span>
          relay<span className="brand-dot">.</span>
        </a>
        <div className="auth-copy">
          <span className="eyebrow">YOUR IDEAS. A TEAM TO EXECUTE THEM.</span>
          <h1>
            Great work
            <br />
            takes a team.
            <br />
            <em>Build yours.</em>
          </h1>
          <p>
            Bring agents, knowledge, and tools together.
            <br />
            Give every task a clear path from idea to outcome.
          </p>
          <div className="auth-graph">
            <div className="auth-node">
              <Network size={20} />
              Orchestrator
            </div>
            <div className="graph-lines" />
            <div className="auth-workers">
              <span>
                <Search size={17} />
                Researcher
              </span>
              <span>
                <Sparkles size={17} />
                Strategist
              </span>
              <span>
                <Check size={17} />
                Reviewer
              </span>
            </div>
          </div>
        </div>
        <small>Designed for work that matters.</small>
      </div>
      <div className="auth-form">
        <div className="local-label">
          <span className="status-dot" /> Your private, local workspace
        </div>
        <h2>
          {challenge
            ? 'Verify your sign-in'
            : reset
              ? 'Reset your password'
              : recover
                ? 'Recover your account'
                : register
                  ? 'Make room for your next idea.'
                  : 'Welcome back.'}
        </h2>
        <p>
          {register
            ? 'Create an account and start with a working agent team.'
            : 'Sign in to your agent workspace.'}
        </p>
        <form onSubmit={submit}>
          {!challenge && !reset && !recover && register && (
            <Field label="Your name">
              <input name="name" autoComplete="name" required placeholder="Alex Morgan" />
            </Field>
          )}
          {!challenge && !reset && (
            <Field label="Email address">
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                placeholder="you@company.com"
              />
            </Field>
          )}
          {!challenge && !recover && (
            <Field label="Password" hint={register ? 'Use at least 10 characters.' : ''}>
              <input
                type="password"
                name="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                required
                minLength={reset || register ? 10 : 1}
                placeholder="Enter your password"
              />
            </Field>
          )}
          {challenge && (
            <Field label="Authenticator or recovery code">
              <input name="code" required autoComplete="one-time-code" />
            </Field>
          )}
          <Button variant="primary" type="submit" disabled={busy}>
            {busy
              ? 'Please wait…'
              : challenge
                ? 'Verify sign-in'
                : reset
                  ? 'Save new password'
                  : recover
                    ? 'Send recovery link'
                    : register
                      ? 'Create workspace'
                      : 'Sign in'}
            <ArrowRight size={17} />
          </Button>
        </form>
        <p className="auth-switch">
          {register ? 'Already have an account?' : 'New to Relay?'}{' '}
          <button
            onClick={() => {
              setRegister(!register);
              setChallenge('');
              setRecover(false);
            }}
          >
            {register ? 'Sign in' : 'Create an account'}
          </button>
        </p>
        {options.sso && !challenge && !reset && (
          <a className="btn" href="/api/auth/sso/start">
            Sign in with your organization
          </a>
        )}
        {options.passwordReset && !challenge && !reset && (
          <Button
            onClick={() => {
              setRegister(false);
              setRecover(!recover);
            }}
          >
            Forgot password?
          </Button>
        )}
        <div className="auth-note">
          <Zap size={17} />
          <span>
            Explore with development preview. Connect your own model whenever you’re ready.
          </span>
        </div>
      </div>
    </div>
  );
}
export default function App() {
  const [user, setUser] = useState<any>(null),
    [workspaces, setWorkspaces] = useState<any[]>([]),
    [wid, setWid] = useState(localStorage.getItem('relay.workspace') || ''),
    [loading, setLoading] = useState(true);
  const initial = new URLSearchParams(location.hash.slice(1));
  const [page, setPage] = useState(initial.get('page') || 'dashboard'),
    [selectedId, setSelectedId] = useState(initial.get('id') || '');
  const [theme, setTheme] = useState(localStorage.getItem('relay.theme') || 'dark'),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(null),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(''),
    [results, setResults] = useState<any>(null),
    [newWorkspace, setNewWorkspace] = useState(false),
    [collapsed, setCollapsed] = useState(false);
  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 6000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const go = useCallback((next: string, id = '') => {
    setPage(next);
    setSelectedId(id);
    location.hash = new URLSearchParams({ page: next, ...(id ? { id } : {}) }).toString();
  }, []);
  const load = useCallback(async () => {
    try {
      const data = await api('/api/me');
      setUser(data.user);
      setWorkspaces(data.workspaces);
      setWid((prev) =>
        data.workspaces.some((w: any) => w.id === prev) ? prev : data.workspaces[0]?.id || '',
      );
      const invite = new URLSearchParams(location.search).get('invite');
      if (invite) {
        const r = await api('/api/invitations/accept', { token: invite });
        setWid(r.workspaceId);
        history.replaceState({}, '', location.pathname + location.hash);
        notify('Invitation accepted');
        const updated = await api('/api/me');
        setWorkspaces(updated.workspaces);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('relay.theme', theme);
  }, [theme]);
  useEffect(() => {
    if (wid) localStorage.setItem('relay.workspace', wid);
  }, [wid]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearch((s) => !s);
      }
      if (e.key === 'Escape') setSearch(false);
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!search || !wid) return;
    const t = setTimeout(() => {
      api(`/api/w/${wid}/search?q=${encodeURIComponent(query)}`)
        .then(setResults)
        .catch((e) => notify(e.message, true));
    }, 200);
    return () => clearTimeout(t);
  }, [query, search, wid, notify]);
  if (location.pathname.startsWith('/apps/'))
    return (
      <ErrorBoundary>
        <PublishedChat appId={location.pathname.split('/')[2]} />
      </ErrorBoundary>
    );
  if (loading) return <Loading />;
  if (!user) return <Auth onComplete={load} notify={notify} />;
  const workspace = workspaces.find((w) => w.id === wid),
    base = `/api/w/${wid}`;
  const props: PageProps = { base, notify, go, role: workspace?.role || 'viewer' };
  const views: Record<string, ReactNode> = {
    dashboard: <Dashboard {...props} user={user} />,
    projects: <Projects {...props} />,
    workflows: <Workflows {...props} />,
    agents: <Agents {...props} />,
    knowledge: <Knowledge {...props} />,
    tools: <Tools {...props} />,
    connections: <Connections {...props} />,
    evaluations: <Evaluations {...props} />,
    prompts: <Prompts {...props} />,
    operations: <Operations {...props} />,
    history: <RunHistory {...props} runId={selectedId} />,
    applications: <Applications {...props} />,
    team: <Team {...props} />,
    settings: <WorkspaceSettings {...props} workspace={workspace} onUpdate={load} />,
  };
  return (
    <ErrorBoundary>
      <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar">
          <a className="brand" href="#page=dashboard" onClick={() => go('dashboard')}>
            <span className="brand-symbol">
              <Network size={22} />
            </span>
            {!collapsed && (
              <>
                relay<span className="brand-dot">.</span>
              </>
            )}
          </a>
          <button
            className="workspace-selector"
            onClick={() => setNewWorkspace(true)}
            title="Manage workspaces"
          >
            <span className="workspace-avatar">{workspace?.name?.[0]?.toUpperCase() || 'W'}</span>
            {!collapsed && (
              <>
                <span>
                  <strong>{workspace?.name}</strong>
                  <small>{workspace?.role} workspace</small>
                </span>
                <ChevronDown size={14} />
              </>
            )}
          </button>
          <button className="sidebar-search" onClick={() => setSearch(true)}>
            <Search size={16} />
            {!collapsed && (
              <>
                <span>Search anything</span>
                <kbd>⌘ K</kbd>
              </>
            )}
          </button>
          <div className="nav-section-label">WORKSPACE</div>
          <nav>
            {nav.slice(0, 4).map((item) => (
              <button
                title={item.name}
                className={
                  page === item.id || (page === 'builder' && item.id === 'workflows')
                    ? 'active'
                    : ''
                }
                key={item.id}
                onClick={() => go(item.id)}
              >
                <item.icon size={18} />
                {!collapsed && item.name}
                {!collapsed && item.id === 'workflows' && <span className="nav-new">BUILD</span>}
              </button>
            ))}
            <div className="nav-section-label">RESOURCES</div>
            {nav
              .slice(4, 12)
              .filter(
                (item) =>
                  item.id !== 'operations' || ['owner', 'administrator'].includes(props.role),
              )
              .map((item) => (
                <button
                  title={item.name}
                  className={page === item.id ? 'active' : ''}
                  key={item.id}
                  onClick={() => go(item.id)}
                >
                  <item.icon size={18} />
                  {!collapsed && item.name}
                </button>
              ))}
          </nav>
          <div className="sidebar-bottom">
            {!collapsed && (
              <div className="preview-note">
                <span>
                  <span className="status-dot" />
                  Development preview
                </span>
                <p>
                  Build freely. Connect a model
                  <br />
                  to run with real intelligence.
                </p>
                <button onClick={() => go('connections')}>
                  Connect a model
                  <ArrowUpRight size={14} />
                </button>
              </div>
            )}
            {nav.slice(12).map((item) => (
              <button
                className={page === item.id ? 'active' : ''}
                title={item.name}
                key={item.id}
                onClick={() => go(item.id)}
              >
                <item.icon size={18} />
                {!collapsed && item.name}
              </button>
            ))}
            <div className="user-strip">
              <span className="user-avatar">{user.name.slice(0, 1)}</span>
              {!collapsed && (
                <span>
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </span>
              )}
              <button
                aria-label="Sign out"
                onClick={async () => {
                  await api('/api/auth/logout', {});
                  setUser(null);
                }}
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <Button
                variant="icon"
                aria-label="Toggle sidebar"
                onClick={() => setCollapsed(!collapsed)}
              >
                <PanelLeftClose size={17} />
              </Button>
              <span>Workspace</span>
              <span className="slash">/</span>
              <strong>
                {page === 'builder'
                  ? 'Workflow builder'
                  : nav.find((n) => n.id === page)?.name || 'Overview'}
              </strong>
            </div>
            <div className="top-actions">
              <span className="local-label">
                <span className="status-dot" />
                Local workspace
              </span>
              <Button
                aria-label="Toggle theme"
                variant="icon"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </Button>
              <Button variant="icon" aria-label="Search workspace" onClick={() => setSearch(true)}>
                <Search size={18} />
              </Button>
              <span className="user-avatar small">{user.name.slice(0, 1)}</span>
            </div>
          </header>
          <main className={page === 'builder' ? 'builder-main' : 'page-main'} key={wid}>
            <Suspense fallback={<Loading />}>
              {page === 'builder' ? (
                <Builder key={selectedId} {...props} workflowId={selectedId} />
              ) : (
                views[page] || views.dashboard
              )}
            </Suspense>
          </main>
        </div>
      </div>
      {toast && (
        <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>
          <span>{toast.error ? '!' : <Check size={16} />}</span>
          {toast.message}
        </div>
      )}
      {search && (
        <Modal
          title="Find your next step"
          subtitle="Search workflows, agents, knowledge, and recorded runs."
          onClose={() => setSearch(false)}
        >
          <div className="command-input">
            <Search size={20} />
            <input
              aria-label="Search workspace"
              placeholder="Search your workspace…"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>ESC</kbd>
          </div>
          <div className="search-results">
            {results &&
              Object.entries(results).map(([group, items]) => (
                <div key={group}>
                  {(items as any[]).length > 0 && (
                    <>
                      <span className="eyebrow">{group}</span>
                      {(items as any[]).map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            go(
                              group === 'workflows'
                                ? 'builder'
                                : group === 'runs'
                                  ? 'history'
                                  : group === 'sources'
                                    ? 'knowledge'
                                    : 'agents',
                              item.id,
                            );
                            setSearch(false);
                          }}
                        >
                          <span>{item.name || `${item.status} · ${item.id.slice(0, 8)}`}</span>
                          <ArrowUpRight size={15} />
                        </button>
                      ))}
                    </>
                  )}
                </div>
              ))}
          </div>
          <div className="command-footer">
            <Command size={13} /> Ctrl / ⌘ K to search · Ctrl / ⌘ Shift L to switch theme
          </div>
        </Modal>
      )}
      {newWorkspace && (
        <Modal
          title="Your workspaces"
          subtitle="Each workspace keeps its workflows, knowledge, and credentials separate."
          onClose={() => setNewWorkspace(false)}
        >
          <div className="workspace-list">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  setWid(w.id);
                  go('dashboard');
                  setNewWorkspace(false);
                }}
              >
                <span className="workspace-avatar">{w.name[0]}</span>
                <span>
                  <strong>{w.name}</strong>
                  <small>{w.role}</small>
                </span>
                {w.id === wid && <Check size={18} />}
              </button>
            ))}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get('name');
              try {
                const r = await api('/api/workspaces', { name });
                await load();
                setWid(r.id);
                go('dashboard');
                setNewWorkspace(false);
                notify('Workspace created');
              } catch (e) {
                notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Create a workspace">
              <input name="name" placeholder="Workspace name" required />
            </Field>
            <Button variant="primary" type="submit">
              <Plus size={16} />
              Create workspace
            </Button>
          </form>
          <form
            className="invite-accept"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const token = new FormData(e.currentTarget).get('token');
                const r = await api('/api/invitations/accept', { token });
                await load();
                setWid(r.workspaceId);
                setNewWorkspace(false);
                notify('Invitation accepted');
              } catch (e) {
                notify((e as Error).message, true);
              }
            }}
          >
            <Field label="Join with an invitation token">
              <input name="token" required placeholder="Paste invitation token" />
            </Field>
            <Button type="submit">Join workspace</Button>
          </form>
        </Modal>
      )}
    </ErrorBoundary>
  );
}
