# Third-party dependencies

This inventory was checked against the installed package manifests and `package-lock.json` on 2026-09-22. DuelLoop is licensed under the [MIT License](LICENSE), retains `private: true`, and has not been published to npm. Its license does not change the licenses of its dependencies. This file records package metadata and the available notice text; it is not a complete legal review of every transitive dependency.

## Direct runtime dependencies

| Package | Locked version | Declared license | Source |
| --- | --- | --- | --- |
| `@typesafe-ai/sdk` | `0.6.0` | MIT | https://github.com/typesafe-ai/typesafe-sdk-js |
| `@earendil-works/pi-coding-agent` | `0.87.0` | MIT | https://github.com/earendil-works/pi/tree/main/packages/coding-agent |
| `@earendil-works/pi-ai` | `0.87.0` | MIT | https://github.com/earendil-works/pi/tree/main/packages/ai |

The TypeSafe npm package includes `LICENSE`, reproduced below. The inspected pi npm packages declare MIT in their `package.json` files but do not include a separate LICENSE or NOTICE file in their installed package trees. Their declared upstream repository is https://github.com/earendil-works/pi. This inventory does not invent an omitted copyright holder or license text for those distributions.

DuelLoop's npm tarball contains its compiled application files and documentation, not an embedded `node_modules` tree. npm installs the above packages and their own dependency trees. Refer to `package-lock.json` and each installed dependency's package manifest, LICENSE and NOTICE files for the transitive inventory and applicable terms. Provider API access and model use are separately governed by the configured service, not by an SDK's source-code license.

## Direct development dependencies

| Package | Installed locked version | Declared license | Available notice |
| --- | --- | --- | --- |
| `typescript` | `5.9.3` | Apache-2.0 | `node_modules/typescript/LICENSE.txt` |
| `@types/node` | `24.13.6` | MIT | `node_modules/@types/node/LICENSE` (Copyright Microsoft Corporation) |

The Node.js runtime and its built-in SQLite support are not bundled by DuelLoop. Consult the Node.js distribution's own license and third-party notices.

## TypeSafe SDK license

The following text is copied from `@typesafe-ai/sdk@0.6.0/LICENSE`:

```text
MIT License

Copyright (c) 2026 TypeSafe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
