import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = path.join(root, ".env");
await mkdir(path.join(root, "data"), { recursive: true });

const token = randomBytes(32).toString("hex");
const contents = [
  "# Generated locally. Do not commit or share this file.",
  `API_TOKEN=${token}`,
  "HOST=127.0.0.1",
  "PORT=3000",
  "DATABASE_PATH=data/relayforge.sqlite",
  "# Local demo receivers are available only when this is true.",
  "DEMO_MODE=true",
  "WORKER_ENABLED=true",
  "RETRY_BASE_MS=1000",
  "",
].join("\n");

try {
  await writeFile(envPath, contents, { flag: "wx", mode: 0o600 });
  console.log("\nRelayForge 本地配置已创建：.env");
  console.log("\n管理 API Token（启动后粘贴到管理界面）：\n");
  console.log(token);
  console.log("\n请妥善保管 Token；它拥有当前工作区的管理权限。");
  console.log("下一步：npm run build，然后 npm start");
  console.log("访问 http://127.0.0.1:3000，连接后可创建演示数据。\n");
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  ) {
    console.log("\n.env 已存在，保留原配置。");
    console.log("请使用 .env 中的 API_TOKEN 连接管理界面。");
    console.log("启动：npm run build，然后 npm start\n");
  } else {
    throw error;
  }
}
