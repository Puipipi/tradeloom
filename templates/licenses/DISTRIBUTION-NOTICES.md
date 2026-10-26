# 分发声明与源码指引

本包包含未修改的desktop16关键compiled文件和冻结工作台壳。部分其他client编译文件只删除带开发机路径的完整 `//#region` 构建注释行；可执行语句没有修改。第三方软件各自按其许可证分发。

- DSH：MIT，全文见本目录LICENSE；上游第三方清单见THIRD_PARTY_NOTICES.md。实际npm包名、版本和声明许可证列于npm-dependencies.json；原依赖许可证保留在各自node_modules目录。
- Electron/Chromium：见engine/LICENSE和engine/LICENSES.chromium.html。
- Node与Python：随包runtime目录内保留原LICENSE/许可文件。Python组件的dist-info目录保留各自许可证。
- Dockview与qrcode-generator：见 `node_modules/@tradeloom/dsh-business-shell/vendor` 下的LICENSE文件。
- LibreOffice kit 0.1.5：MPL-2.0；保留完整win32-x64 engine package、licenses、sources配方/补丁。对应源代码仓库是 https://github.com/deepseek-ai/dsh-libreoffice-kit 。LibreOffice core对应revision为 `bce0998afefdbc355585ca324285661a2170ba77`，仓库 https://github.com/LibreOffice/core ；具体配置及本地改动见平台包sources/core.json及core-changes.patch。收到本包的人可按这些资料获取对应源码。
- sharp 0.35.5 / libvips 8.18.7：sharp为Apache-2.0；平台库还含LGPL-3.0-or-later等组件。保留平台包README、LICENSE、versions.json；各库版本和许可表在 `node_modules/@img/sharp-win32-x64`。libvips DLL作为独立文件分发，允许按适用许可证替换、调试和为此目的进行逆向工程；本包不施加额外限制。源码/构建配方仓库 https://github.com/lovell/sharp-libvips ，libvips源码仓库 https://github.com/libvips/libvips 。收到本包的人应按versions.json指定的对应版本获取源代码及补丁。

源码链接及配方不等于本包包含所有依赖的完整源码档案。许可证及声明保留情况是本次打包检查的一部分；不要把根MIT许可理解成取代第三方的MPL/LGPL或其他义务。
