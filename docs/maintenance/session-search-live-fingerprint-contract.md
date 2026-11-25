# 活动会话搜索的不可变快照指纹（665）

基底：63e255fab5cb9d817af30b631c3643ccce8e9231 / v1.0.11，DSH 0.2.2-rc.1。Refs #444、#463、#370。本项降低已建索引后重复搜索的处理成本，不承诺解决这些报告的首帧解析、Android卡顿或远程闪退。

## 既有所有权与失效合同

官方 `Session` 为每个实例建立独立的日志数组。无参 `snapshotEvents()` 返回当前完整不可变快照，在下一次 append 前复用同一个数组；append 在发布观察事件前使该快照缓存失效。旧快照保持稳定。Session header 与 inheritedEventCount 在该实例的生命周期中不可变。恢复路径可以接管独占拥有的事件而不把每个外层对象都物理 deepFreeze；这里依赖的是官方不可变与所有权转移合同，不把所有恢复对象都已深冻结当事实。

`observeLive` 因此可以只读使用这个已接受的完整快照。每个 SQLite 查询引擎用一个 WeakMap，以完整快照数组为弱 key、以既有 SHA256 指纹字符串为 value。append、新 Session（即使同 ID）或恢复得到不同完整快照，必重新计算指纹；不同查询引擎不共享此表。表值不保存 detached 事件、搜索文档、Session 或快照强引用，不能由它单独延长快照生命周期。

## 保持的边界

每次观察仍复制 header、重新构建及校验搜索文档；只有成功构建文档后才读取或记录指纹。首次与变化后的指纹使用原字段顺序与原算法。冷会话仍走原 `observeSession`，保留其 detach 与重算。持久标志变化、持久化绑定变化、删除、代际和游标检查仍由现有外层逻辑决定，不能因为快照指纹相同而略过它们。

搜索的 `currentSessionMessageProjections` 是 format-catalog 导出的固定集合，与 `SessionStore.registerMessageProjection` 的实例注册表不同。不能把后者的公开注册/卸载写成已证明会改变前者的事实；本项没有通过修改导出数组或私有 Session 日志制造测试。

本修没有新增 RPC 字段、配置开关、SQL 物化或磁盘缓存。搜索仍需构建语义文档、执行 SQLite 查询，并处理持久化来源；不宣称整次搜索为 O(1)。缓存只省去活动事件的重复复制和同一完整快照的 JSON 序列化、哈希；少量弱表条目和指纹字符串仍有内存成本。

**会改 runtimeVersion。Android 未编译。** PRoot、ARM、真实模型、App 和真机性能未在本项运行；桌面公开服务夹具和成本计数不能替代它们。
