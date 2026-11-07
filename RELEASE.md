# 发布清单

当前所有包保持 `private: true`，不发布到任何公共 registry，也未配置 Trusted Publisher。本清单只描述 0.0.1 发布前必须通过的验证与产物口径，发布动作尚未启用。

## 发布前门禁

| 命令 | 证明什么 | 产物 |
|------|----------|------|
| `pnpm run gate:release-metadata` | npm 主包、四个原生平台包与 wasm 占位包的版本、许可与入口一致；Python 与 Cargo 版本一致；`CHANGELOG.md` 最新版本等于 workspace 版本 | — |
| `pnpm run gate:install-ts` | `pnpm pack` 出的主包与当前平台包能在纯 Node 下安装、`import` 并执行真实调用；归档内含 `License.md`、`dist/` 与两个 `bin` 入口 | 2 个 tarball |
| `pnpm run gate:install-py` | wheel 内含 METADATA、`dist-info/licenses/License.md` 与编译扩展；装进干净 venv 后真实调用通过 | 1 个 wheel |
| `pnpm run test:ts` / `pnpm run test:py` | 两侧绑定对同一批 case 输出一致 | — |
| `pnpm run test:server` / `pnpm run test:server:py` | 真实驱动连本仓服务端完成 handshake、CRUD 与鉴权 | — |
| `pnpm run gate:test-count` | 断言数与 case 数不低于门槛，`skipped` 为 0 | — |
| `pnpm run gate:corpus` | 与 `mongod 8.0.9` 的差异语料全部通过（需可连的 `mongod`） | — |
| `pnpm run test:rust` / `pnpm run check` | Rust workspace 冒烟测试与 `cargo check` 通过 | — |

`check-rust.yml` 另外执行 `cargo fmt --all -- --check`、Clippy 与 workspace 测试，任一失败都视为发布阻断。

## 产物口径

- **版本**：根 `package.json`、npm 主包、五个平台包、`pyproject.toml` 与 Cargo workspace 必须同为 `0.0.1`。
- **npm 主包**：ESM 包，`exports` 只声明 `types` / `import` / `default` 且都指向 `dist/`，不声明 `require`；`files` 只含 `bin` 与 `dist`；`bin` 暴露 `yydb-mongo` 与 `yydb-mongod`。
- **平台包**：`darwin-arm64`、`darwin-x64`、`linux-x64`、`win32-x64` 四个原生包列入主包 `optionalDependencies` 且版本相同；wasm 占位包不列入。
- **Python 包**：`yydb-mongo` 由 maturin 从 `mongo-pyo3` 构建，模块名 `mongo.mongo_pyo3`，METADATA 含 `License-Expression: MPL-2.0`、`License-File: License.md` 与 `text/markdown` 长描述。
- **许可**：根 `License.md` 的同一份 MPL-2.0 文本随 npm 主包、五个平台包与 Python 包分发，逐字节一致。
- **驱动矩阵**：`mongodb` 实测 `6.22.0`、CI 安装 `^6.12.0`；`pymongo` 实测 `4.19.0`、CI 安装 `>=4.11,<5.0`；`mongosh` 只为手工冒烟，不入 CI。
