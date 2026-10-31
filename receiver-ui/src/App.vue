<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

interface Order {
  orderId: string;
  amount: number;
  currency: string;
  status: string;
  updatedAt: string;
}
interface Receipt {
  eventId: string;
  eventType: string;
  receivedAt: string;
  outcome: string;
  deliveryId: string;
}

const orders = ref<Order[]>([]);
const receipts = ref<Receipt[]>([]);
const query = ref('');
const loading = ref(true);
const refreshing = ref(false);
const error = ref('');
const syncedAt = ref<Date | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
let aborter: AbortController | undefined;

const visibleOrders = computed(() => {
  const term = query.value.trim().toLowerCase();
  return term ? orders.value.filter(order => order.orderId.toLowerCase().includes(term)) : orders.value;
});
const statusLabel = (status: string) => ({ received: '已接收', created: '已创建', paid: '已支付', fulfilled: '已履约', cancelled: '已取消' })[status.toLowerCase()] ?? status;
const outcomeLabel = (outcome: string) => ({ processed: '已处理', accepted: '已处理', duplicate: '重复事件' })[outcome.toLowerCase()] ?? outcome;
const formatTime = (value: string) => {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', { hour12: false });
};
const formatAmount = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amount / 100); }
  catch { return `${(amount / 100).toFixed(2)} ${currency}`; }
};

async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  aborter = new AbortController();
  try {
    const [ordersResponse, receiptsResponse] = await Promise.all([
      fetch('/receiver/api/orders', { signal: aborter.signal }),
      fetch('/receiver/api/receipts', { signal: aborter.signal }),
    ]);
    if (!ordersResponse.ok || !receiptsResponse.ok) throw new Error(`服务返回 HTTP ${!ordersResponse.ok ? ordersResponse.status : receiptsResponse.status}`);
    const [orderData, receiptData]: [{ items: Order[] }, { items: Receipt[] }] = await Promise.all([ordersResponse.json(), receiptsResponse.json()]);
    if (!Array.isArray(orderData.items) || !Array.isArray(receiptData.items)) throw new Error('接收服务返回的数据格式不正确');
    orders.value = orderData.items;
    receipts.value = receiptData.items;
    syncedAt.value = new Date();
    error.value = '';
  } catch (caught) {
    if (caught instanceof Error && caught.name === 'AbortError') return;
    error.value = caught instanceof TypeError ? '无法连接接收服务。请检查后端和本地演示模式是否已启动。' : caught instanceof Error ? caught.message : '无法读取接收服务数据';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 5000); });
onUnmounted(() => { if (timer) clearInterval(timer); aborter?.abort(); });
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="订单工作台首页"><span class="brand-mark">R<span>·</span></span><span>RelayForge <small>/ RECEIVER</small></span></a>
      <div class="top-right"><span class="demo-badge"><span></span> 本地演示</span><a href="http://127.0.0.1:3000/" target="_blank" rel="noreferrer">投递控制台 <span aria-hidden="true">↗</span></a></div>
    </header>

    <main class="page">
      <div class="breadcrumb"><span>RELAYFORGE</span><span>/</span><span>业务接收端</span></div>
      <section class="hero">
        <div><p class="eyebrow">ORDER FULFILLMENT <span> / </span> 01</p><h1>订单工作台<span>.</span></h1><p class="intro">追踪订单事件，观察接收端如何处理来自 RelayForge 的投递。</p></div>
        <div class="hero-actions"><div class="connection"><span :class="['connection-dot', { offline: !!error }]"></span><span>{{ error ? '接收服务未连接' : syncedAt ? '接收服务已连接' : '正在连接' }}</span></div><button class="refresh-button" :disabled="refreshing" @click="refresh"><span :class="{ spinning: refreshing }">↻</span> {{ refreshing ? '同步中' : '刷新数据' }}</button></div>
      </section>

      <div v-if="error" class="alert" role="alert"><span>!</span><div><strong>暂时无法同步数据</strong><p>{{ error }}</p></div><button @click="refresh" :disabled="refreshing">重试</button></div>

      <section class="flow-card" aria-label="事件流转过程">
        <div class="flow-copy"><span class="flow-kicker">从事件到业务</span><strong>每笔订单，都有来处。</strong><p>控制台发布订单事件，接收服务验证签名并处理，结果会展示在这里。</p></div>
        <div class="flow-steps"><div class="flow-step"><span class="flow-num">01</span><strong>发布事件</strong><small>RELAYFORGE</small></div><span class="flow-line"></span><div class="flow-step"><span class="flow-num">02</span><strong>验签与去重</strong><small>SPRING BOOT</small></div><span class="flow-line"></span><div class="flow-step active"><span class="flow-num">03</span><strong>更新订单</strong><small>VUE WORKBENCH</small></div></div>
      </section>

      <section class="stats" aria-label="业务概览">
        <article class="stat"><div class="stat-heading"><span>展示的订单</span><span class="stat-icon">▦</span></div><strong>{{ syncedAt ? orders.length : '—' }}</strong><p>接收服务返回的订单</p><small>ORDERS</small></article>
        <article class="stat"><div class="stat-heading"><span>收到的事件</span><span class="stat-icon">↙</span></div><strong>{{ syncedAt ? receipts.length : '—' }}</strong><p>显示的接收记录</p><small>RECEIPTS</small></article>
        <article class="stat stat-wide"><div class="stat-heading"><span>最后同步</span><span class="stat-icon">◷</span></div><strong class="stat-time">{{ syncedAt ? syncedAt.toLocaleTimeString('zh-CN', { hour12: false }) : '—' }}</strong><p>页面每 5 秒自动更新</p><small>AUTO SYNC</small></article>
      </section>

      <div class="content-grid">
        <section class="panel orders-panel">
          <div class="panel-head"><div><p class="section-kicker">BUSINESS DATA / 01</p><h2>订单列表 <span>{{ orders.length }}</span></h2><p>由成功处理的事件生成</p></div><label class="search"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索订单编号" aria-label="搜索订单编号" /></label></div>
          <div v-if="loading" class="empty"><span class="empty-icon">◌</span><strong>正在加载订单</strong><p>正在连接接收服务…</p></div>
          <div v-else-if="error && !syncedAt" class="empty"><span class="empty-icon">!</span><strong>无法读取订单</strong><p>连接接收服务后，订单会显示在这里。</p></div>
          <div v-else-if="!orders.length" class="empty"><span class="empty-icon">▤</span><strong>还没有订单</strong><p>从 RelayForge 发布 <code>order.created</code> 事件后，订单会出现在这里。</p><a href="http://127.0.0.1:3000/" target="_blank" rel="noreferrer">前往投递控制台 <span aria-hidden="true">↗</span></a></div>
          <div v-else-if="!visibleOrders.length" class="empty"><span class="empty-icon">⌕</span><strong>没有找到订单</strong><p>请尝试其他订单编号。</p></div>
          <div v-else class="table-wrap"><table><thead><tr><th>订单编号</th><th>金额</th><th>状态</th><th>更新时间</th></tr></thead><tbody><tr v-for="order in visibleOrders" :key="order.orderId"><td><span class="order-icon">▤</span><strong>{{ order.orderId }}</strong></td><td class="amount">{{ formatAmount(order.amount, order.currency) }}</td><td><span class="pill"><i></i>{{ statusLabel(order.status) }}</span></td><td class="date">{{ formatTime(order.updatedAt) }}</td></tr></tbody></table></div>
          <div class="panel-footer"><span>显示 {{ visibleOrders.length }} / {{ orders.length }} 条订单</span><span>金额按最小货币单位换算</span></div>
        </section>

        <section class="panel receipts-panel">
          <div class="panel-head"><div><p class="section-kicker">EVENT HISTORY / 02</p><h2>接收记录 <span>{{ receipts.length }}</span></h2><p>查看事件处理结果</p></div><span class="live-indicator"><i></i> LIVE</span></div>
          <div v-if="loading" class="empty compact"><span class="empty-icon">◌</span><strong>正在加载记录</strong></div>
          <div v-else-if="error && !syncedAt" class="empty compact"><span class="empty-icon">!</span><strong>无法读取记录</strong><p>请先启动接收服务。</p></div>
          <div v-else-if="!receipts.length" class="empty compact"><span class="empty-icon">↙</span><strong>等待第一个事件</strong><p>收到事件后，处理记录将显示在这里。</p></div>
          <ol v-else class="receipt-list"><li v-for="(receipt, index) in receipts" :key="`${receipt.eventId}-${receipt.deliveryId}-${index}`"><span class="receipt-marker">{{ receipt.outcome.toLowerCase() === 'duplicate' ? '↻' : '✓' }}</span><div><div class="receipt-head"><strong>{{ receipt.eventType }}</strong><span>{{ outcomeLabel(receipt.outcome) }}</span></div><p :title="receipt.eventId">{{ receipt.eventId }}</p><time>{{ formatTime(receipt.receivedAt) }}</time></div></li></ol>
          <div class="panel-footer"><span>接收记录</span><span>自动刷新 <span aria-hidden="true">↻</span></span></div>
        </section>
      </div>

      <footer><span><strong>R<span>·</span></strong> RELAYFORGE <i>/</i> RECEIVER DEMO</span><span>VUE 3 <i>·</i> SPRING BOOT <i>·</i> WEBHOOKS</span></footer>
    </main>
  </div>
</template>
