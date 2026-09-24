// 打出可安装的 tgz。文件名固定为 dsh-pro-max-bridge-<version>.tgz：安装 URL 由它
// 拼出来（README 的安装步骤），改名等于改安装命令。pnpm pack 默认用含 scope 的包名
// 生成文件名，这里换掉。
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync("pnpm", ["pack", "--pack-destination", out], { stdio: "inherit" });

const produced = readdirSync(out).filter((file) => file.endsWith(".tgz"));
if (produced.length !== 1) {
  throw new Error(`expected exactly one tarball in ${out}, found ${produced.length}`);
}
const target = `dsh-pro-max-bridge-${version}.tgz`;
renameSync(join(out, produced[0]), join(out, target));
console.log(`\npacked ${out}/${target}`);
