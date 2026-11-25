# 有界 snippet 窗口：实现前合同与停点证明

基底 prefix63 `dsh-session-query-sqlite/lib/index.js:325–374`。先读 search-snippet63/README：旧候选省 join/Array.from 在 8 MiB 反序测量变慢，已停止。本方向不同，仅讨论在第一命中后的输出窗口已经确定时停止扫描。当前为隔离候选；公开边界与性能证据另存，不以源码证明代替实测。

## 实际消费

公开 searchSessions/searchEvents 查询返回行后，:914 对 row.marked_text 调用 makeSnippet；:961/984 使用 SQLite FTS5 highlight。snippetChars 合法正整数，默认240，允许1/2/3。README61承诺 Unicode 码点长度上限与稳定纯文本摘要。文档及查询先 sanitizeFtsText(:295) 替换 NUL/U+FDD0/U+FDD1，因而正文碰撞不是新marker；原消毒仍必须保留，不能把直接私有marked字符串当正常生产fixture。

## 要保持的旧行为

1. 用 for...of 逐 Unicode 码点和 `/\s/u` 识别空白；前导空白不输出，中间空白run输出一个ASCII空格，最终尾部单空格删除。孤立代理项仍为原for...of单位，不能顺手替换或改grapheme。
2. 第一开marker记录当时临时normalized长度，可能包含最终要删的空格；闭marker与后续开marker不输出。末尾必须按 min(matchStart,N−1) clamp。没有marker默认0。
3. 完整长度N<=M优先返回全clean，包括M=1。不能看到marker就先加ellipsis。
4. 长文本M=1返回ellipsis。M=2/3须原样复用旧window分支：prefix在最初start计算后固定，contentLength<1重置start也不重算prefix；near-end扩大窗口也不重算prefix。不可将这些看似不自然的结果修正。

## 有限缓冲设计

维护全局normalized码点计数n、是否末项为待确认空格、firstMarker，首M个码点，以及最后2M+4码点的环形窗口。firstM用于短全文/无marker默认开头；尾环用于晚marker前置上下文及EOF回补。环形存储不可用每次shift引入新的O(M)循环。

写入空格时可立即记入n（保持marker观察值），但不能据该空格认定全文已经超过边界。每遇到非空白普通码点后，当前n均为确认长度：即使立即EOF也不会被trim回退。marker自身不确认尾空格。

在firstMarker已知后，按旧makeSnippet的同一计算顺序，用当前n计算一次拟窗口（包括prefix固定、cap2/3特殊分支）。仅当 n>M 且 firstMarker<n 且拟end<n 时，可提前返回该窗口：

- 实际最终N>=n，故短全文分支永不再进入；
- marker的clamp已稳定，因为firstMarker<n<=N；
- start/prefix/contentLength只取决于M与稳定marker；
- end<n<=N证明不会触发near-end回补。后续文本、marker和空白都不能改变结果。

M=1可独立在确认n>1时返回ellipsis，不必继续找marker。无marker的一般M场景仍扫到EOF，不虚称常数扫描。

EOF时若末项空格，n减1；随后按最终n及第一marker完全执行旧窗口计算。环形及首段中多保留的尾空格不参与最终索引。near-end只需要最后M个码点，已有环形覆盖；最初marker前需要至多floor(M/3)，后续停止点至多一个结果窗口，因此2M+4是保守容量，不要求保留完整前缀。

## 必要公开边界清单

通过真实Session/SQLite public search结果与原版逐值比较，不直接导出helper：

- 短/恰M/长文本；cap1/2/3与默认240。
- 首命中在开头、中部、末尾；多次命中保持只取首个的位置。
- 前导/中间/尾部空白run、换行/tab及Unicode空白；末尾命中后只有空白，不能提前误定suffix。
- near-end回补及旧prefix不重算的输出。
- 中文、emoji和实际可由持久化接受的文本；码点计数不等同UTF16单位。
- 正文含保留marker码点时走现有sanitize再FTS，结果无marker泄漏。

SQLite正常highlight是否产生“仅尾空白marker”或完全无marker，以实际public查询为准；不能为了覆盖私有宽输入而伪造producer。以上非全部已经验证的用例。

## 预期范围与停止条件

早命中长尾可能省大部分normalize扫描/完整临时字符数组；晚命中仍必须扫描前缀，SQLite highlight与排序/读回完整marked_text也未优化，不可宣称总成本O(M)或节约全部8MiB内存。无marker可能仅省数组而非扫描，旧join原型负面仍须保留。先由作者测真实公开成本与典型位置；无稳定价值不继续，为所有权/捕获/校验增加缓存不在方案内。

## 极大合法预算与存储界限

配置的 assertPositiveInteger 仅要求 Number.isInteger(value) 且 value>=1，未要求 safe integer，也未设上限。实现不得通过 `new Array(2*M+4)` 提前分配预算大小。

当前原型 first=[]、tail=[] 均只随真实读取字符增长。若 M 大于实际全文长度，所有已读索引落入 first，最终走完整文本路径；tail 容量虽可能大于整数精确范围，实际索引仍小于真实短文本长度。M=Number.MAX_VALUE 时2*M+4为Infinity，有限索引 % Infinity仍等于该索引，既不触发数组长度构造错误，也不产生新NaN索引。无新文本长度承诺：只证明既有可用JS字符串的正常有限索引范围。

因此无需修改正在测量的原型来加cap上限；上限会改变公开配置合同。成本上动态buffer为O(min(N,M))，并非先分配O(M)；首段和尾环仍有指针/字符数组空间，未测RSS，不说零额外存储。

## 可迁移测试草稿与现有实测边界

runtime/tests/search-snippet-window.test.mjs为真实Context/SessionStore/SQLite公开searchEvents，lazy DSH_TEST_PREFIX??DSH_PREFIX缺失时逐测试skip，不在模块顶层加载前缀，不依赖CLI/Python/外部二进制。当前18案：12个已测原版golden，4个短文本大cap，cap1短全文优先，真实tab/newline/Unicode尾空白的near-end控制。

12个golden从原版实际完整结果中提取，原controls使用真实tab/newline；新6案补极大预算等相邻控制，不重新实现算法充当oracle。最终原版18/18、候选18/18；与完整query-open-retry六案合计候选24/24。首次测试移植把工具输出的转义展示误读为字面字符，并手算错一条near-end期望，造成准备失败；raw保留，不计功能红。

编号688；Refs #444、#463，仅正常大文档搜索成本，不宣称修复具体设备症状。固定性能完成后仅删除无调用normalizeMarkedText，未变更受测makeSnippet算法；新18案和相关6案是在删死代码后执行。
