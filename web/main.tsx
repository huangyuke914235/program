import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Braces,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Filter,
  Globe2,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Terminal,
  Webhook,
  X,
  Zap,
  CircleAlert,
  Clock3,
  Inbox,
  CheckCircle2,
} from "lucide-react";
import type {
  Attempt,
  AuditEntry,
  DashboardStats,
  Delivery,
  DeliveryStatus,
  Endpoint,
  EventRecord,
} from "../server/types";
import "./style.css";

type Page = "overview" | "deliveries" | "endpoints" | "activity" | "settings";
type Detail = { delivery: Delivery; event: EventRecord; attempts: Attempt[] };
type Modal = "event" | "endpoint" | null;
const tokenStorage = "relayforge-token";
const statusLabels: Record<DeliveryStatus, string> = {
  pending: "等待投递",
  processing: "投递中",
  retrying: "等待重试",
  delivered: "已送达",
  dead: "已失败",
};
const pageLabels: Record<Page, string> = {
  overview: "概览",
  deliveries: "投递记录",
  endpoints: "接收端点",
  activity: "操作日志",
  settings: "连接设置",
};
const navItems = [
  { id: "overview" as const, label: "概览", icon: LayoutDashboard },
  { id: "deliveries" as const, label: "投递记录", icon: ArrowUpRight },
  { id: "endpoints" as const, label: "接收端点", icon: Webhook },
  { id: "activity" as const, label: "操作日志", icon: Activity },
];

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const dateTime = (date: string) =>
  new Date(date).toLocaleString("zh-CN", { hour12: false });
const shortTime = (date: string) =>
  new Date(date).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
function ago(date: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";

function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand${small ? " small" : ""}`}>
      <span className="brand-mark">
        <Zap size={small ? 17 : 21} fill="currentColor" strokeWidth={1.4} />
      </span>
      <span>
        RelayForge<span className="brand-dot">.</span>
      </span>
    </span>
  );
}
function Status({ value }: { value: DeliveryStatus }) {
  return (
    <span className={`status status-${value}`}>
      <span className="status-dot" />
      {statusLabels[value]}
    </span>
  );
}
function Empty({
  icon: Icon = Inbox,
  title,
  text,
  action,
}: {
  icon?: typeof Inbox;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={23} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Dialog({
  title,
  caption,
  children,
  onClose,
  wide = false,
  locked = false,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  locked?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`dialog${wide ? " wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div className="dialog-top">
        <div>
          <span className="eyebrow">RELAYFORGE / CONTROL ROOM</span>
          <h2>{title}</h2>
          {caption && <p>{caption}</p>}
        </div>
        <button
          className="icon-button"
          aria-label="关闭弹窗"
          disabled={locked}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function CopyButton({
  value,
  label = "复制",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <button
      className="button subtle small-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setError(false);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setError(true);
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "已复制" : error ? "请选择并手动复制" : label}
    </button>
  );
}

function ActivityChart({ stats }: { stats: DashboardStats | null }) {
  const activity = stats?.activity ?? [];
  const max = Math.max(
    4,
    ...activity.map((item) => item.delivered + item.failed),
  );
  const width = 800,
    height = 155,
    barWidth = 18;
  const bars = activity.length
    ? activity
    : Array.from({ length: 24 }, () => ({ hour: "", delivered: 0, failed: 0 }));
  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <div>
          <h2>
            投递活动 <span className="heading-muted">Delivery activity</span>
          </h2>
          <p>过去 24 小时的投递尝试结果</p>
        </div>
        <span className="period">
          <Clock3 size={13} />
          最近 24 小时
        </span>
      </div>
      <div className="chart-wrap">
        <div className="chart-y">
          <span>{max}</span>
          <span>{Math.round(max / 2)}</span>
          <span>0</span>
        </div>
        <svg
          className="activity-chart"
          viewBox={`0 0 ${width} ${height + 30}`}
          role="img"
          aria-label="最近24小时的成功与失败投递尝试柱状图"
        >
          {[0, 0.5, 1].map((n, i) => (
            <line
              key={n}
              x1="0"
              x2={width}
              y1={i === 2 ? height : n * height + 1}
              y2={i === 2 ? height : n * height + 1}
              stroke="var(--border)"
              strokeDasharray={i === 2 ? "0" : "3 5"}
            />
          ))}
          {bars.map((item, i) => {
            const x =
              i * (width / bars.length) + (width / bars.length - barWidth) / 2;
            const delivered = (item.delivered / max) * (height - 8),
              failed = (item.failed / max) * (height - 8);
            return (
              <g key={item.hour || i}>
                <title>
                  {item.hour ? dateTime(item.hour) : "暂无活动"}：成功{" "}
                  {item.delivered} / 失败 {item.failed}
                </title>
                <rect
                  x={x}
                  y={height - delivered}
                  width={barWidth}
                  height={Math.max(delivered, 0.5)}
                  rx="2"
                  fill="var(--green)"
                  opacity=".82"
                />
                {failed > 0 && (
                  <rect
                    x={x}
                    y={height - delivered - failed - 2}
                    width={barWidth}
                    height={failed}
                    rx="2"
                    fill="var(--orange)"
                    opacity=".9"
                  />
                )}
                {i % Math.max(1, Math.floor(bars.length / 6)) === 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={height + 23}
                    fill="var(--muted)"
                    fontSize="10"
                    textAnchor="middle"
                  >
                    {item.hour
                      ? new Date(item.hour).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })
                      : `${String(i).padStart(2, "0")}:00`}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {!activity.some((item) => item.delivered || item.failed) && (
          <div className="chart-zero">
            等待第一个事件<span>发布事件后，投递结果将在这里实时出现</span>
          </div>
        )}
      </div>
      <div className="chart-footer">
        <span className="chart-legend">
          <i className="legend-dot green" />
          成功投递 <i className="legend-dot orange" />
          失败尝试
        </span>
        <span>
          每 5 秒自动同步
          <RefreshCw size={11} />
        </span>
      </div>
    </section>
  );
}

function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem(tokenStorage) ?? "",
  );
  const [tokenDraft, setTokenDraft] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [page, setPage] = useState<Page>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [total, setTotal] = useState(0);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [status, setStatus] = useState<DeliveryStatus | "">("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncAt, setSyncAt] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailTab, setDetailTab] = useState<"attempts" | "payload">(
    "attempts",
  );
  const [busy, setBusy] = useState("");
  const [endpointName, setEndpointName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [eventType, setEventType] = useState("order.created");
  const [payload, setPayload] = useState(`{
  "orderId": "order_1001",
  "amount": 199,
  "currency": "CNY"
}`);
  const [selectedEndpoints, setSelectedEndpoints] = useState<string[]>([]);
  const [formError, setFormError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const api = useCallback(
    async <T,>(
      path: string,
      init?: RequestInit,
      overrideToken?: string,
    ): Promise<T> => {
      let response: Response;
      try {
        response = await fetch(`/api${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${overrideToken ?? token}`,
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...init?.headers,
          },
        });
      } catch {
        throw new Error("无法连接服务，请检查后端是否已启动。");
      }
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new ApiError(
          data?.error?.message ?? `请求失败（HTTP ${response.status}）`,
          response.status,
        );
      return data as T;
    },
    [token],
  );
  const refresh = () => setRefreshKey((key) => key + 1);
  const notify = (message: string) => {
    setToast(message);
  };
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setDemoMode(data.demoMode === true))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        modal ||
        detailId ||
        (target instanceof HTMLElement &&
          (target.matches("input, textarea, select") ||
            target.isContentEditable))
      )
        return;
      if (searchRef.current) {
        event.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [modal, detailId]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false,
      pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const [nextStats, nextEndpoints, nextDeliveries, nextAudit] =
          await Promise.all([
            api<DashboardStats>("/stats"),
            api<{ items: Endpoint[] }>("/endpoints"),
            api<{ items: Delivery[]; total: number }>(
              `/deliveries?limit=20&offset=${offset}${status ? `&status=${status}` : ""}`,
            ),
            api<{ items: AuditEntry[] }>("/audit"),
          ]);
        if (cancelled) return;
        setStats(nextStats);
        setEndpoints(nextEndpoints.items);
        setDeliveries(nextDeliveries.items);
        setTotal(nextDeliveries.total);
        setAudit(nextAudit.items);
        setSyncAt(new Date().toISOString());
        setError("");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          sessionStorage.removeItem(tokenStorage);
          setToken("");
          setLoginError("API Token 无效或已更换，请重新连接。");
        } else setError(errorText(err));
      } finally {
        pending = false;
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [api, token, status, offset, refreshKey]);
  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError("");
    const load = () =>
      api<Detail>(`/deliveries/${encodeURIComponent(detailId)}`)
        .then((data) => {
          if (!cancelled) {
            setDetail(data);
            setDetailError("");
          }
        })
        .catch((err) => {
          if (!cancelled) setDetailError(errorText(err));
        });
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [detailId, api, refreshKey]);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setLoginError("");
    try {
      await api("/stats", undefined, tokenDraft.trim());
      sessionStorage.setItem(tokenStorage, tokenDraft.trim());
      setToken(tokenDraft.trim());
      setTokenDraft("");
      setLoading(true);
    } catch (err) {
      setLoginError(errorText(err));
    } finally {
      setConnecting(false);
    }
  }
  function navigate(next: Page) {
    setPage(next);
    setMobileNav(false);
  }
  function openModal(next: Modal) {
    setModal(next);
    setFormError("");
    setSecret("");
    if (next === "event") setSelectedEndpoints([]);
  }
  async function bootstrap() {
    setBusy("demo");
    try {
      await api("/demo/bootstrap", { method: "POST" });
      notify("演示事件已发布。可以在投递详情中观察失败与自动重试。");
      refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  }
  async function toggleEndpoint(endpoint: Endpoint) {
    setBusy(endpoint.id);
    try {
      await api(`/endpoints/${encodeURIComponent(endpoint.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !endpoint.enabled }),
      });
      notify(
        endpoint.enabled ? "端点已暂停，等待中的任务将保留。" : "端点已恢复。",
      );
      refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  }
  async function addEndpoint(event: React.FormEvent) {
    event.preventDefault();
    setBusy("endpoint");
    setFormError("");
    try {
      const created = await api<Endpoint & { secret: string }>("/endpoints", {
        method: "POST",
        body: JSON.stringify({
          name: endpointName.trim(),
          url: endpointUrl.trim(),
        }),
      });
      setSecret(created.secret);
      setEndpointName("");
      setEndpointUrl("");
      refresh();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy("");
    }
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault();
    setFormError("");
    let data: unknown;
    try {
      data = JSON.parse(payload);
      if (!data || Array.isArray(data) || typeof data !== "object")
        throw new Error("Payload 必须是一个 JSON 对象。");
    } catch (err) {
      setFormError(
        err instanceof SyntaxError
          ? "JSON 格式有误，请检查引号、逗号和括号。"
          : errorText(err),
      );
      return;
    }
    setBusy("event");
    try {
      const result = await api<{ event: EventRecord; deliveries: Delivery[] }>(
        "/events",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            type: eventType.trim(),
            payload: data,
            ...(selectedEndpoints.length
              ? { endpointIds: selectedEndpoints }
              : {}),
          }),
        },
      );
      setModal(null);
      notify(`事件已创建，已安排 ${result.deliveries.length} 个投递任务。`);
      setStatus("");
      setOffset(0);
      refresh();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy("");
    }
  }
  async function retryDelivery(delivery: Delivery) {
    setBusy(delivery.id);
    try {
      await api(`/deliveries/${encodeURIComponent(delivery.id)}/retry`, {
        method: "POST",
      });
      notify("已重新加入投递队列。");
      refresh();
    } catch (err) {
      setDetailError(errorText(err));
    } finally {
      setBusy("");
    }
  }
  const enabledEndpoints = endpoints.filter((endpoint) => endpoint.enabled);
  const filteredDeliveries = deliveries.filter((delivery) =>
    `${delivery.id} ${delivery.eventType} ${delivery.endpointName} ${delivery.eventId}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const inFlight = stats
    ? stats.pending + stats.processing + stats.retrying
    : 0;

  if (!token)
    return (
      <main className="login-page">
        <div className="login-grid" />
        <div className="login-brand">
          <Logo />
          <span className="version">v1.0 / WEBHOOK INFRASTRUCTURE</span>
        </div>
        <div className="login-layout">
          <div className="login-story">
            <span className="eyebrow">
              <span className="tiny-dot" /> BUILT FOR RELIABLE DELIVERY
            </span>
            <h1>
              每一个事件，
              <br />
              都有可靠的<span>下一站。</span>
            </h1>
            <p>
              从事件接收到签名投递、失败重试与全程追踪。
              <br />
              让系统之间的连接，清晰、可控、值得信赖。
            </p>
            <div className="login-flow">
              <span>
                <Braces size={18} />
                Event
              </span>
              <i />
              <span className="flow-engine">
                <Zap size={18} />
                RelayForge
              </span>
              <i />
              <span>
                <Webhook size={18} />
                Endpoint
              </span>
            </div>
            <div className="login-points">
              <span>
                <ShieldCheck size={15} />
                HMAC 签名
              </span>
              <span>
                <RefreshCw size={15} />
                自动重试
              </span>
              <span>
                <CheckCheck size={15} />
                持久化队列
              </span>
            </div>
          </div>
          <section className="login-card">
            <span className="connection-icon">
              <Terminal size={23} />
            </span>
            <h2>连接你的控制台</h2>
            <p>使用服务端的 API Token 管理投递。</p>
            <form onSubmit={connect}>
              <label htmlFor="api-token">API Token</label>
              <div className="input-icon">
                <KeyRound size={16} />
                <input
                  id="api-token"
                  type="password"
                  autoComplete="off"
                  placeholder="输入 .env 中的 API_TOKEN"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  required
                />
              </div>
              {loginError && (
                <div className="form-error" role="alert">
                  <CircleAlert size={15} />
                  {loginError}
                </div>
              )}
              <button
                className="button primary login-submit"
                disabled={connecting || !tokenDraft.trim()}
              >
                {connecting ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <>
                    连接控制台
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>
            <div className="login-note">
              <ShieldCheck size={15} />
              <span>Token 仅在当前浏览器标签页会话中保存。</span>
            </div>
            <div className="setup-note">
              <span>首次使用？在项目目录运行</span>
              <code>npm run setup</code>
              <span>然后从生成的 .env 文件中获取 API_TOKEN。</span>
            </div>
          </section>
        </div>
        <footer className="login-footer">
          <span>RELAYFORGE · EVENT DELIVERY, ENGINEERED.</span>
          <span>TypeScript / SQLite / React</span>
        </footer>
      </main>
    );

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar${mobileNav ? " visible" : ""}`}>
        <a
          className="brand-link"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <Logo />
        </a>
        <div className="workspace">
          <span className="workspace-avatar">
            <Globe2 size={17} />
          </span>
          <div>
            <strong>我的工作空间</strong>
            <span>Webhook infrastructure</span>
          </div>
          <span className="workspace-tag">LOCAL</span>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="主导航">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item${page === id ? " active" : ""}`}
              onClick={() => navigate(id)}
            >
              <Icon size={17} />
              {label}
              {id === "deliveries" && !!stats?.total && (
                <span className="nav-count">{number(stats.total)}</span>
              )}
              {id === "endpoints" && !!endpoints.length && (
                <span className="nav-count">{endpoints.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-icon">
              <Zap size={15} />
            </span>
            <strong>为可靠连接而构建</strong>
            <p>
              事件持久化、自动重试。
              <br />
              每一次投递都有迹可循。
            </p>
            <button onClick={() => navigate("settings")}>
              查看连接信息
              <ArrowUpRight size={13} />
            </button>
          </div>
          <button
            className={`nav-item${page === "settings" ? " active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={17} />
            连接设置
          </button>
          <div className="sidebar-user">
            <span className="user-avatar">RF</span>
            <div>
              <strong>Developer</strong>
              <span>本地控制台</span>
            </div>
            <button
              className="icon-button"
              aria-label="断开连接"
              title="断开连接"
              onClick={() => {
                sessionStorage.removeItem(tokenStorage);
                setToken("");
                setStats(null);
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="展开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-workspace">工作空间</span>
            <span className="slash">/</span>
            <span>{pageLabels[page]}</span>
          </div>
          <div className="topbar-right">
            {demoMode && <span className="demo-badge">DEMO MODE</span>}
            <span className={`connection-status${error ? " offline" : ""}`}>
              <i />
              {error ? "同步异常" : loading ? "正在连接" : "服务已连接"}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              title="连接设置"
              aria-label="查看连接设置"
              onClick={() => navigate("settings")}
            >
              <CircleHelp size={17} />
            </button>
            <span className="topbar-avatar">RF</span>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === "overview"
                  ? "DELIVERY CONTROL ROOM"
                  : page.toUpperCase()}
              </span>
              <h1>
                {pageLabels[page]}
                <span className="page-heading-dot">.</span>
              </h1>
              <p>
                {page === "overview"
                  ? "从接收到送达，掌握每一个事件的去向。"
                  : page === "deliveries"
                    ? "查看投递状态，定位失败原因，追踪每次尝试。"
                    : page === "endpoints"
                      ? "连接你的服务，管理事件的目的地。"
                      : page === "activity"
                        ? "关键操作的时间线，让每一次变更都有记录。"
                        : "管理当前控制台的连接与运行环境。"}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary refresh-button"
                onClick={refresh}
                title="刷新数据"
              >
                <RefreshCw size={15} />
                <span>刷新</span>
              </button>
              {page === "endpoints" ? (
                <button
                  className="button primary"
                  onClick={() => openModal("endpoint")}
                >
                  <Plus size={16} />
                  添加端点
                </button>
              ) : (
                <button
                  className="button primary"
                  onClick={() => openModal("event")}
                >
                  <Plus size={16} />
                  发布事件
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={16} />
              <span>{error}</span>
              <button onClick={refresh}>重新连接</button>
            </div>
          )}
          {demoMode && stats?.events === 0 && (
            <div className="demo-intro">
              <span className="demo-intro-icon">
                <Zap size={20} />
              </span>
              <div>
                <strong>从一次真实投递开始</strong>
                <p>创建演示端点和事件，观察成功投递与自动重试的完整过程。</p>
              </div>
              <button
                className="button secondary"
                onClick={() => void bootstrap()}
                disabled={busy === "demo"}
              >
                {busy === "demo" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Play size={14} />
                )}
                运行演示
              </button>
            </div>
          )}
          {(page === "overview" || page === "deliveries") && (
            <>
              <div className="metrics-grid">
                <div className="metric-card">
                  <div className="metric-top">
                    <span>累计投递</span>
                    <ArrowUpRight size={16} />
                  </div>
                  <strong>
                    {stats ? (
                      number(stats.total)
                    ) : (
                      <span className="skeleton metric-skeleton" />
                    )}
                  </strong>
                  <div className="metric-bottom">
                    <span className="muted">
                      来自 {stats ? number(stats.events) : "—"} 个事件
                    </span>
                    <span className="metric-label">TOTAL DELIVERIES</span>
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-top">
                    <span>投递成功率</span>
                    <CheckCircle2 size={16} />
                  </div>
                  <strong>
                    {stats ? `${Number(stats.successRate.toFixed(1))}` : "—"}
                    <small>%</small>
                  </strong>
                  <div className="metric-bottom">
                    <span className="green-text">
                      <span className="inline-dot" />
                      {stats ? number(stats.delivered) : "—"} 次已送达
                    </span>
                    <span className="metric-label">SUCCESS RATE</span>
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-top">
                    <span>队列处理中</span>
                    <RefreshCw size={16} />
                  </div>
                  <strong>{stats ? number(inFlight) : "—"}</strong>
                  <div className="metric-bottom">
                    <span className="muted">
                      {stats ? number(stats.retrying) : "—"} 次等待重试
                    </span>
                    <span className="metric-label">IN FLIGHT</span>
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-top">
                    <span>失败待处理</span>
                    <CircleAlert size={16} />
                  </div>
                  <strong className={stats?.dead ? "orange-text" : ""}>
                    {stats ? number(stats.dead) : "—"}
                  </strong>
                  <div className="metric-bottom">
                    <span className="muted">
                      {stats?.dead
                        ? "可在详情中手动重新投递"
                        : "当前没有失败的投递"}
                    </span>
                    <span className="metric-label">DEAD LETTERS</span>
                  </div>
                </div>
              </div>
              {page === "overview" && <ActivityChart stats={stats} />}
              <section className="panel delivery-panel">
                <div className="panel-heading">
                  <div className="section-title-row">
                    <h2>{page === "overview" ? "最近投递" : "全部投递"}</h2>
                    <span className="count-badge">{number(total)}</span>
                  </div>
                  <span className="panel-note">
                    <span className="tiny-dot" />
                    实时更新
                  </span>
                </div>
                <div className="table-toolbar">
                  <div className="search-input">
                    <Search size={15} />
                    <input
                      ref={searchRef}
                      aria-label="搜索当前页投递"
                      placeholder="搜索事件、端点或 ID…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <kbd>/</kbd>
                  </div>
                  <label className="filter-select">
                    <Filter size={14} />
                    <select
                      aria-label="按投递状态筛选"
                      value={status}
                      onChange={(e) => {
                        setStatus(e.target.value as DeliveryStatus | "");
                        setOffset(0);
                      }}
                    >
                      <option value="">全部状态</option>
                      {Object.entries(statusLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} />
                  </label>
                </div>
                <div className="table-scroll">
                  <table className="deliveries-table">
                    <thead>
                      <tr>
                        <th>事件 / EVENT</th>
                        <th>接收端点</th>
                        <th>状态</th>
                        <th>尝试次数</th>
                        <th>创建时间</th>
                        <th>
                          <span className="sr-only">详情</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading
                        ? Array.from({ length: 4 }, (_, i) => (
                            <tr key={i} className="skeleton-row">
                              <td colSpan={6}>
                                <span className="skeleton" />
                              </td>
                            </tr>
                          ))
                        : filteredDeliveries.map((delivery) => (
                            <tr key={delivery.id} className="delivery-row">
                              <td>
                                <button
                                  className="event-cell"
                                  onClick={() => {
                                    setDetailId(delivery.id);
                                    setDetailTab("attempts");
                                  }}
                                >
                                  <span
                                    className={`event-icon ${delivery.status === "dead" ? "event-icon-error" : ""}`}
                                  >
                                    <Braces size={17} />
                                  </span>
                                  <span>
                                    <strong>{delivery.eventType}</strong>
                                    <code>{delivery.id.slice(0, 18)}</code>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <span className="endpoint-cell">
                                  <span className="endpoint-mini-dot" />
                                  {delivery.endpointName}
                                </span>
                              </td>
                              <td>
                                <Status value={delivery.status} />
                              </td>
                              <td>
                                <span className="attempts-cell">
                                  {delivery.attempts}
                                  <span> / {delivery.maxAttempts}</span>
                                </span>
                              </td>
                              <td>
                                <span
                                  className="table-time"
                                  title={dateTime(delivery.createdAt)}
                                >
                                  {ago(delivery.createdAt)}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`查看 ${delivery.eventType} 的投递详情`}
                                  onClick={() => {
                                    setDetailId(delivery.id);
                                    setDetailTab("attempts");
                                  }}
                                >
                                  <ArrowUpRight size={16} />
                                </button>
                              </td>
                            </tr>
                          ))}
                    </tbody>
                  </table>
                </div>
                {!loading && !filteredDeliveries.length && (
                  <Empty
                    title={
                      search || status
                        ? "没有匹配的投递"
                        : "你的第一条投递，即将出发"
                    }
                    text={
                      search
                        ? "搜索仅针对当前页，请尝试其他关键词或翻页。"
                        : status
                          ? "试试其他状态筛选，或发布一个新的事件。"
                          : "添加一个接收端点，发布事件，剩下的交给 RelayForge。"
                    }
                    action={
                      !search && !status ? (
                        <button
                          className="button secondary"
                          onClick={() =>
                            openModal(endpoints.length ? "event" : "endpoint")
                          }
                        >
                          <Plus size={14} />
                          {endpoints.length ? "发布事件" : "添加端点"}
                        </button>
                      ) : (
                        <button
                          className="button subtle"
                          onClick={() => {
                            setSearch("");
                            setStatus("");
                          }}
                        >
                          清除筛选
                        </button>
                      )
                    }
                  />
                )}
                <div className="table-footer">
                  <span>
                    {search
                      ? `本页匹配 ${filteredDeliveries.length} 条`
                      : `共 ${number(total)} 条投递`}
                    {total > 0 && ` · 第 ${Math.floor(offset / 20) + 1} 页`}
                  </span>
                  <div>
                    <button
                      className="icon-button"
                      aria-label="上一页"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - 20))}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="下一页"
                      disabled={offset + 20 >= total}
                      onClick={() => setOffset(offset + 20)}
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
          {page === "endpoints" && (
            <>
              <div className="endpoint-summary">
                <span className="summary-icon">
                  <Webhook size={22} />
                </span>
                <div>
                  <strong>{endpoints.length} 个端点</strong>
                  <span>
                    {enabledEndpoints.length} 个运行中 ·{" "}
                    {endpoints.length - enabledEndpoints.length} 个已暂停
                  </span>
                </div>
                <span className="endpoint-security">
                  <ShieldCheck size={14} />
                  所有投递均使用 HMAC-SHA256 签名
                </span>
              </div>
              <section className="endpoints-list">
                {endpoints.map((endpoint) => (
                  <article className="panel endpoint-card" key={endpoint.id}>
                    <div className="endpoint-card-top">
                      <span
                        className={`endpoint-large-icon${endpoint.enabled ? "" : " paused"}`}
                      >
                        <Webhook size={23} />
                      </span>
                      <div>
                        <h2>{endpoint.name}</h2>
                        <code>{endpoint.id}</code>
                      </div>
                      <span
                        className={`endpoint-state${endpoint.enabled ? "" : " paused"}`}
                      >
                        <i />
                        {endpoint.enabled ? "运行中" : "已暂停"}
                      </span>
                    </div>
                    <div className="endpoint-url">
                      <Globe2 size={14} />
                      <code title={endpoint.url}>{endpoint.url}</code>
                      <CopyButton value={endpoint.url} label="复制地址" />
                    </div>
                    <div className="endpoint-card-bottom">
                      <span>创建于 {dateTime(endpoint.createdAt)}</span>
                      <button
                        className="button secondary small-button"
                        disabled={busy === endpoint.id}
                        onClick={() => void toggleEndpoint(endpoint)}
                      >
                        {busy === endpoint.id ? (
                          <LoaderCircle className="spin" size={13} />
                        ) : endpoint.enabled ? (
                          <Pause size={13} />
                        ) : (
                          <Play size={13} />
                        )}
                        {endpoint.enabled ? "暂停端点" : "恢复端点"}
                      </button>
                    </div>
                  </article>
                ))}
              </section>
              {!loading && !endpoints.length && (
                <section className="panel">
                  <Empty
                    icon={Webhook}
                    title="连接你的第一个服务"
                    text="添加一个 HTTPS 接收地址。RelayForge 将为每次投递签名，并自动处理暂时性失败。"
                    action={
                      <button
                        className="button primary"
                        onClick={() => openModal("endpoint")}
                      >
                        <Plus size={14} />
                        添加端点
                      </button>
                    }
                  />
                </section>
              )}
            </>
          )}
          {page === "activity" && (
            <section className="panel audit-panel">
              <div className="panel-heading">
                <h2>
                  最近操作<span className="heading-muted">Audit trail</span>
                </h2>
                <span className="period">最近 {audit.length} 条</span>
              </div>
              {!audit.length ? (
                <Empty
                  icon={Activity}
                  title="所有变化，从这里开始"
                  text="创建端点、发布事件和重新投递等关键操作，会记录在这条时间线上。"
                />
              ) : (
                <div className="audit-list">
                  {audit.map((entry) => (
                    <div className="audit-item" key={entry.id}>
                      <span className="audit-icon">
                        <Activity size={15} />
                      </span>
                      <div>
                        <strong>{entry.action}</strong>
                        <p>{entry.detail}</p>
                        <code>{entry.resourceId}</code>
                      </div>
                      <time title={dateTime(entry.createdAt)}>
                        {ago(entry.createdAt)}
                      </time>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {page === "settings" && (
            <div className="settings-grid">
              <section className="panel settings-panel">
                <span className="settings-icon">
                  <Terminal size={22} />
                </span>
                <div className="settings-heading">
                  <h2>控制台连接</h2>
                  <a
                    className="button subtle small-button"
                    href="/api/docs"
                    target="_blank"
                    rel="noreferrer"
                  >
                    API 文档
                    <ArrowUpRight size={13} />
                  </a>
                </div>
                <p>使用同源 API，管理当前 RelayForge 实例。</p>
                <dl>
                  <div>
                    <dt>API 地址</dt>
                    <dd>
                      <code>{window.location.origin}/api</code>
                    </dd>
                  </div>
                  <div>
                    <dt>认证方式</dt>
                    <dd>Bearer API Token</dd>
                  </div>
                  <div>
                    <dt>运行模式</dt>
                    <dd>{demoMode ? "本地演示模式" : "标准模式"}</dd>
                  </div>
                  <div>
                    <dt>最近同步</dt>
                    <dd>{syncAt ? dateTime(syncAt) : "正在连接…"}</dd>
                  </div>
                  <div>
                    <dt>控制台版本</dt>
                    <dd>
                      <code>v1.0.0</code>
                    </dd>
                  </div>
                </dl>
                <button
                  className="button secondary"
                  onClick={() => {
                    sessionStorage.removeItem(tokenStorage);
                    setToken("");
                    setStats(null);
                  }}
                >
                  <LogOut size={14} />
                  断开当前连接
                </button>
              </section>
              <section className="panel settings-panel">
                <span className="settings-icon orange-icon">
                  <ShieldCheck size={22} />
                </span>
                <h2>连接的每一步，清晰可查</h2>
                <p>服务端保存事件与任务，控制台仅负责展示和管理。</p>
                <ul className="feature-list">
                  <li>
                    <Check size={15} />
                    <div>
                      <strong>签名投递</strong>
                      <span>接收端使用端点密钥，验证请求真实性。</span>
                    </div>
                  </li>
                  <li>
                    <Check size={15} />
                    <div>
                      <strong>自动重试</strong>
                      <span>暂时性失败按指数退避和随机抖动重新投递。</span>
                    </div>
                  </li>
                  <li>
                    <Check size={15} />
                    <div>
                      <strong>幂等接收</strong>
                      <span>API 使用 Idempotency-Key 避免重复创建事件。</span>
                    </div>
                  </li>
                  <li>
                    <Check size={15} />
                    <div>
                      <strong>持久化追踪</strong>
                      <span>查询每次尝试、HTTP 状态和失败原因。</span>
                    </div>
                  </li>
                </ul>
                {demoMode && (
                  <button
                    className="button secondary"
                    onClick={() => void bootstrap()}
                    disabled={busy === "demo"}
                  >
                    {busy === "demo" ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <Play size={14} />
                    )}
                    创建一轮演示投递
                  </button>
                )}
              </section>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <span className="footer-mark">↗</span> RELAYFORGE
              <span className="footer-slash">/</span>可靠连接，从这里开始。
            </span>
            <span>
              {syncAt ? `最后同步 ${shortTime(syncAt)}` : "正在同步…"}
              <span className="footer-slash">·</span>v1.0.0
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {modal === "endpoint" && (
        <Dialog
          locked={busy === "endpoint"}
          title={secret ? "端点已就绪" : "添加接收端点"}
          caption={
            secret
              ? "请立即保存签名密钥，它仅在这里显示一次。"
              : "事件将在后台投递至这个地址。"
          }
          onClose={() => setModal(null)}
        >
          {secret ? (
            <div className="dialog-body">
              <div className="secret-alert">
                <KeyRound size={18} />
                <div>
                  <strong>保存你的签名密钥</strong>
                  <p>
                    接收端需要此密钥来验证 Webhook 签名。关闭后无法再次查看。
                  </p>
                </div>
              </div>
              <div className="secret-value">
                <code>{secret}</code>
                <CopyButton value={secret} label="复制密钥" />
              </div>
              <button
                className="button primary full-width"
                onClick={() => setModal(null)}
              >
                <Check size={15} />
                已保存密钥
              </button>
            </div>
          ) : (
            <form onSubmit={addEndpoint} className="dialog-body">
              <label htmlFor="endpoint-name">端点名称</label>
              <input
                id="endpoint-name"
                autoFocus
                placeholder="例如：订单服务"
                value={endpointName}
                onChange={(e) => setEndpointName(e.target.value)}
                maxLength={80}
                required
              />
              <label htmlFor="endpoint-url">接收 URL</label>
              <input
                id="endpoint-url"
                type="url"
                placeholder="https://your-service.com/webhooks"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                required
              />
              <p className="field-hint">
                使用可公开访问的 HTTPS 地址。内网和本机地址默认受保护。
              </p>
              <div className="form-note">
                <ShieldCheck size={16} />
                <span>
                  创建后将生成专属 HMAC 签名密钥。请在接收端验证签名，并按事件
                  ID 去重。
                </span>
              </div>
              {formError && (
                <div className="form-error" role="alert">
                  <CircleAlert size={15} />
                  {formError}
                </div>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy === "endpoint" || busy === "event"}
                  onClick={() => setModal(null)}
                >
                  取消
                </button>
                <button
                  className="button primary"
                  disabled={busy === "endpoint"}
                >
                  {busy === "endpoint" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Plus size={15} />
                  )}
                  创建端点
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
      {modal === "event" && (
        <Dialog
          locked={busy === "event"}
          title="发布一个事件"
          caption="事件将先持久化，再由后台 Worker 可靠投递。"
          onClose={() => setModal(null)}
          wide
        >
          <form className="dialog-body" onSubmit={publish}>
            <label htmlFor="event-type">事件类型</label>
            <input
              id="event-type"
              autoFocus
              placeholder="order.created"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              maxLength={100}
              required
            />
            <div className="field-label-row">
              <label htmlFor="event-payload">事件数据</label>
              <span>JSON OBJECT</span>
            </div>
            <textarea
              id="event-payload"
              className="code-input"
              spellCheck={false}
              rows={8}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              required
            />
            <div className="field-label-row">
              <label>接收端点</label>
              <span>不选择则投递至全部运行中的端点</span>
            </div>
            {enabledEndpoints.length ? (
              <div className="endpoint-checkbox-list">
                {enabledEndpoints.map((endpoint) => (
                  <label className="endpoint-checkbox" key={endpoint.id}>
                    <input
                      type="checkbox"
                      checked={selectedEndpoints.includes(endpoint.id)}
                      onChange={(e) =>
                        setSelectedEndpoints((current) =>
                          e.target.checked
                            ? [...current, endpoint.id]
                            : current.filter((id) => id !== endpoint.id),
                        )
                      }
                    />
                    <span>
                      <strong>{endpoint.name}</strong>
                      <code>{endpoint.url}</code>
                    </span>
                    <Webhook size={16} />
                  </label>
                ))}
              </div>
            ) : (
              <div className="form-note warning">
                <CircleAlert size={16} />
                <span>
                  还没有运行中的接收端点。请先添加端点，或在演示模式下运行演示。
                </span>
              </div>
            )}
            {formError && (
              <div className="form-error" role="alert">
                <CircleAlert size={15} />
                {formError}
              </div>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy === "endpoint" || busy === "event"}
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy === "event" || !enabledEndpoints.length}
              >
                {busy === "event" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Send size={15} />
                )}
                发布事件
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {detailId && (
        <Dialog
          title="投递详情"
          caption={detailId}
          onClose={() => setDetailId(null)}
          wide
        >
          <div className="detail-body">
            {detailError && (
              <div className="form-error" role="alert">
                <CircleAlert size={15} />
                {detailError}
              </div>
            )}
            {!detail ? (
              <div className="detail-loading">
                <LoaderCircle size={24} className="spin" />
                加载投递详情…
              </div>
            ) : (
              <>
                <div className="detail-summary">
                  <div>
                    <span className="detail-type-icon">
                      <Braces size={21} />
                    </span>
                    <h3>{detail.delivery.eventType}</h3>
                  </div>
                  <Status value={detail.delivery.status} />
                </div>
                <dl className="detail-meta">
                  <div>
                    <dt>接收端点</dt>
                    <dd>{detail.delivery.endpointName}</dd>
                  </div>
                  <div>
                    <dt>目标地址</dt>
                    <dd>
                      <code>{detail.delivery.endpointUrl}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>事件 ID</dt>
                    <dd>
                      <code>{detail.event.id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{dateTime(detail.delivery.createdAt)}</dd>
                  </div>
                  {detail.delivery.nextAttemptAt && (
                    <div>
                      <dt>下次尝试</dt>
                      <dd>{dateTime(detail.delivery.nextAttemptAt)}</dd>
                    </div>
                  )}
                </dl>
                <div className="detail-tabs">
                  <button
                    className={detailTab === "attempts" ? "active" : ""}
                    onClick={() => setDetailTab("attempts")}
                  >
                    <Activity size={14} />
                    投递尝试<span>{detail.attempts.length}</span>
                  </button>
                  <button
                    className={detailTab === "payload" ? "active" : ""}
                    onClick={() => setDetailTab("payload")}
                  >
                    <Braces size={14} />
                    事件数据
                  </button>
                </div>
                {detailTab === "payload" ? (
                  <div className="payload-block">
                    <div>
                      <span>application/json</span>
                      <CopyButton
                        value={JSON.stringify(detail.event.payload, null, 2)}
                      />
                    </div>
                    <pre>{JSON.stringify(detail.event.payload, null, 2)}</pre>
                  </div>
                ) : detail.attempts.length ? (
                  <div className="attempt-list">
                    {[...detail.attempts].reverse().map((attempt) => (
                      <div
                        className={`attempt-item${attempt.statusCode && attempt.statusCode >= 200 && attempt.statusCode < 300 ? " success" : ""}`}
                        key={attempt.id}
                      >
                        <span className="attempt-marker">
                          {attempt.statusCode &&
                          attempt.statusCode >= 200 &&
                          attempt.statusCode < 300 ? (
                            <Check size={13} />
                          ) : !attempt.finishedAt ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : (
                            <X size={13} />
                          )}
                        </span>
                        <div className="attempt-content">
                          <div className="attempt-header">
                            <strong>第 {attempt.number} 次尝试</strong>
                            <span
                              className={`http-code${attempt.statusCode && attempt.statusCode >= 200 && attempt.statusCode < 300 ? " success" : ""}`}
                            >
                              {attempt.statusCode
                                ? `HTTP ${attempt.statusCode}`
                                : attempt.finishedAt
                                  ? "连接失败"
                                  : "处理中"}
                            </span>
                            {attempt.durationMs !== null && (
                              <span className="attempt-duration">
                                {attempt.durationMs} ms
                              </span>
                            )}
                          </div>
                          <time>{dateTime(attempt.startedAt)}</time>
                          {attempt.error && (
                            <p className="attempt-error">{attempt.error}</p>
                          )}
                          {attempt.responseBody && (
                            <details>
                              <summary>响应内容</summary>
                              <pre>{attempt.responseBody}</pre>
                            </details>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={Clock3}
                    title="等待首次投递"
                    text="Worker 将在后台处理，详情每 5 秒更新。"
                  />
                )}
                {["delivered", "dead"].includes(detail.delivery.status) && (
                  <div className="detail-bottom">
                    <span>重新投递会保留历史记录。</span>
                    <button
                      className="button secondary"
                      disabled={busy === detail.delivery.id}
                      onClick={() => void retryDelivery(detail.delivery)}
                    >
                      {busy === detail.delivery.id ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      重新投递
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
