// 打出可安装的 tgz，文件名**不含版本号**：安装地址是
//   https://github.com/sperictao/dsh-pro-max-bridge/releases/latest/download/dsh-pro-max-bridge.tgz
// 靠 GitHub 的 latest 重定向永远指向最新一个 Release。名字里带版本号的话每次发版这个
// 地址都会变，用户就得重粘一次——而版本号在包内 package.json 里，安装后照样查得到。
// pnpm pack 默认用含 scope 的包名生成文件名，这里换掉。
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync("pnpm", ["pack", "--pack-destination", out], { stdio: "inherit" });

const produced = readdirSync(out).filter((file) => file.endsWith(".tgz"));
if (produced.length !== 1) {
  throw new Error(`expected exactly one tarball in ${out}, found ${produced.length}`);
}
const target = "dsh-pro-max-bridge.tgz";
renameSync(join(out, produced[0]), join(out, target));
console.log(`\npacked ${out}/${target}`);
