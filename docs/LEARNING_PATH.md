# 从完成的项目开始学

先让 Spring Boot、React 管理台和 Vue 订单工作台跑起来，再沿着一个真实事件读代码。每一步都通过实际状态或测试验证，不需要先背完框架知识。

## 第一步：从两个界面理解业务

按 README 启动主项目，在 React 控制台创建演示数据，再打开 Vue 订单工作台。

观察四个端点：正常响应、前两次失败后恢复、永久拒绝、订单接收。点击投递详情，查看状态码和尝试历史；然后在 Vue 中找到本次事件生成的订单。

完成标准：能解释“事件”“端点”“投递”“尝试”“订单”分别是什么，并指出它们在两个界面中的位置。

起点：[Models.java](../java/src/main/java/com/relayforge/store/Models.java)、[React 界面](../web/)、[Vue 界面](../receiver-ui/src/App.vue)。

## 第二步：读懂 Spring Boot 请求链路

打开 `/api/docs`，使用管理 Token 查询端点并创建事件。尝试不传 Token、发送错误 JSON、选择不存在的端点，比较响应。

沿着 [AccessFilter.java](../java/src/main/java/com/relayforge/api/AccessFilter.java) → [ApiController.java](../java/src/main/java/com/relayforge/api/ApiController.java) → [RelayStore.java](../java/src/main/java/com/relayforge/store/RelayStore.java) 阅读，找出认证、输入校验、业务调用与响应映射的位置。

完成标准：能解释 `@RestController`、构造器注入、`@Valid` 的作用，并说明为什么界面隐藏按钮无法替代后端认证。

## 第三步：验证事务与幂等

在 Store 中找到事件与投递一起写入的事务。使用同一 `Idempotency-Key` 重复发送相同事件，再保持键不变修改载荷。

检查重复请求是否返回已有事件，冲突请求是否拒绝，以及事件/投递总数是否增加。阅读 [RelayStoreTest.java](../java/src/test/java/com/relayforge/store/RelayStoreTest.java) 对应测试，找出测试保护的业务不变量。

完成标准：能解释原子性、唯一约束、请求指纹，以及“防止重复创建事件”与“接收方只执行业务一次”之间的边界。

## 第四步：读懂后台任务与恢复

阅读 [DeliveryWorker.java](../java/src/main/java/com/relayforge/worker/DeliveryWorker.java) 和 Store 的任务领取/完成方法。画出状态流转，找出定时调度、租约和退避计算。

实验：提交事件后停止进程，重启并等待未完成任务恢复；暂停端点再提交事件，观察恢复端点后的变化。只在本地独立测试数据库上操作。

完成标准：能解释租约为何过期、旧 worker 为什么不能覆盖新结果，以及为什么网络请求不能放在数据库写事务里。

## 第五步：理解接收方的业务事务

阅读 [DemoReceiver.java](../java/src/main/java/com/relayforge/api/DemoReceiver.java) 的 `shop` 分支，以及 [ApiIntegrationTest.java](../java/src/test/java/com/relayforge/api/ApiIntegrationTest.java) 中重复送达和签名篡改测试。

在 React 中重放一个已经成功的订单投递，检查 Vue 中的订单和唯一接收记录。对照代码解释：收到重复请求时，为何返回成功但不重新更新订单。

完成标准：能解释去重记录与业务写入必须处于同一事务的原因，并说明至少一次投递为何仍然可靠。

## 第六步：检查签名与出站安全

阅读 [WebhookSecurity.java](../java/src/main/java/com/relayforge/worker/WebhookSecurity.java) 和 [PinnedHttpTransport.java](../java/src/main/java/com/relayforge/worker/PinnedHttpTransport.java)。

分别找到原始请求体验签、时间窗口、DNS 校验、固定地址连接、超时与大小限制。注册一个普通私网目标，确认系统拒绝它；再检查为何内置演示端点可以被限定放行。

完成标准：能解释 JSON 重新序列化为何可能破坏签名，DNS 重新解析为何可能绕过地址检查，以及自动重定向会带来什么额外边界。

## 第七步：比较 React 与 Vue 的数据流

两个界面都由 HTTP 查询结果驱动，但用途不同。读出各自的加载、错误、空状态、定时刷新与用户操作流程。

练习：给 Vue 订单列表增加一个本地状态筛选，并确保空结果文案正确。然后在 React 中增加一个投递查询条件，判断筛选应该发生在浏览器还是后端数据库。

完成标准：能说明组件状态、计算结果与 API 数据的关系，并运行两个前端的类型检查与构建。

## 第八步：独立完成一个工程扩展

选一个目标，先写行为约束，再改代码并运行 `npm run check`：

| 扩展 | 需要判断的问题 |
| --- | --- |
| 订单状态事件 | `order.paid` 如何更新既有订单？乱序事件如何处理？ |
| 事件保留期限 | 哪些记录可以清理？如何保留未完成任务和审计证据？ |
| 队列等待指标 | 从何时开始计时？自动重试的等待时间是否计入？ |
| 独立接收服务 | 拆到另一个 Spring Boot 应用时，密钥与部署怎么配置？ |
| PostgreSQL Store | 如何保持幂等、领取、租约和故障恢复测试继续通过？ |

完成标准：可以演示前后差异，解释一个取舍，并指出测试覆盖的故障情况。

## 测试与旧实现怎么用

`npm test` 运行 Java 测试；`npm run check` 再验证两个前端构建。原 Node 实现在 `server/`，旧测试需通过 `npm run test:legacy` 单独运行；它们可以用于比较实现思路，但不能证明 Spring Boot 代码正确。

对照旧代码时，优先比较同一业务不变量的实现：例如事务回滚、租约令牌和规范化指纹。避免因为文件名或表名相同就假设行为完全兼容。

## 作品集演示顺序

发布一个事件，展示重试与死信，打开尝试记录，再切到 Vue 查看订单落地。随后沿着 Java Controller、Store、worker、接收业务事务解释链路，最后说明单机 SQLite、共享 Token 和至少一次语义的边界。

只介绍能定位到代码、测试或运行结果的能力。未实现的多租户、跨主机调度和高吞吐目标应明确作为下一步设计方向。
