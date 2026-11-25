# 等长 hunk 重建的局部优化

基底 63e255fab5cb9d817af30b631c3643ccce8e9231。Refs W17-B，无对应公开issue编号。会改 runtimeVersion；Android 未编译。

仅在实际 replacement.oldLength === replacement.newLines.length 时，逐下标写入 owned lines 数组。长度不同仍使用原 spread，排序与 reverse 不变。匹配、EOF 回游、同位置顺序、失败返回、尾空行 retry、末尾 LF 重建均不变；不声称全部 patch 更快。

所有匹配先对 original 完成，start 在 [0,N]，逆序重建的 start 非递增。若当前长度 L>=s，旧拼接后长度 s+m+max(L-s-k,0)>=s，因此后续起点仍在当前数组内或末端。等长 m=k 时：L>=s+k 则覆盖保持 prefix/suffix；s<=L<s+k 则连续写入扩展至 s+k，无 holes，等价于旧 prefix+newLines+空 suffix。零长度等长不操作，与复制的内容相同。比较的是 retry 后实际 replacement，不是原 hunk 长度。

lines 来自 before.split 或内部新数组，不与调用者 hunk 数组共享；重建时匹配已全部结束。字符串和 hunk 输入不被修改。合法重叠与 EOF 回游不被禁止。

这是性能优化而非功能缺陷修复，原版和候选的语义 golden 均应通过。固定真实 Context/LocalFS.patchText 测量为四独立进程 AB/BA，每进程 71B/1hunk 与 880003B/20hunk 各3warm+5timed。大输入中位 AB 15.736810→8.747910ms，BA原11.995933/候8.293520ms；小输入 AB 2.438799→2.494849ms退化，BA原2.362730/候2.242179ms。仅该宿主固定样本，不推广为设备/全规模收益；全部原始样本保留，不重复追加。没有真实模型或 Android/PRoot/ARM 验收。
