# 后台屏首帧就绪与安全窗口

Refs #621、#515 第1点。近黑像素不证明 FLAG_SECURE：初始未绘制、普通黑色画面和被保护内容都可能近黑。当前 ImageReader 后台屏捕获没有可靠 FLAG_SECURE 检测源；保留显式 secureWindow 错误优先级，不把该已有分支描述为可靠检测器。

一次 capture 只创建一个 ImageReader、设置一次 surface，共用原2500毫秒等待期限。首帧近黑后先关闭 Image，再短等至多200毫秒且不超过剩余期限，最多额外取得一帧；不重复 launch、tap、text、scroll、key，也不为重试再次读取整棵树。

已知无帧到期或两帧仍近黑，不输出截图或控件内容。纯 OP_OBSERVE 返回 frameNotReady；BackgroundDisplay 已有失败读取路径清掉旧screen/element标识。已经派发的动作保持原OK结果，观察Bundle新增可选布尔 frameNotReady=true、secure=false、n=0，不含image或element数组；BackgroundDisplay产生明确“画面尚未就绪；稍后仅重新读屏，不要重放刚才动作”快照，同时清掉旧元素与比较缓存。旧端忽略新增字段时仍只得到0项，不会收到不确定内容。

IMAGE_OMITTED 仍只表示秘密/控件树不完整，不承载未就绪；原完整树、秘密脱敏与截图限制保持。显式secure错误仍优先。树读取错误按既有纯读传播/写后观察可省略的区别处理，不由黑帧改写；截图格式/编码等故障不归类为frameNotReady。截图取消/中断必须立即退出；其它截图故障保持原有“没有截图但仍可读取有效树”的语义，纯读与写后观察均不因这些故障新增整次失败，也不把它们标为frameNotReady。无新增权限、自检或FLAG_SECURE绕过。

本环境未运行App JVM/Android，未声称首红/最终绿。新增纯策略由生产capture调用，其Kotlin测试仅给本机执行；新API在旧基底缺失的编译失败不算语义首红。真机需对原版与候选比较正常应用冷启、持续黑画面、明确受保护页面、取消/释放和动作次数，记录等待上界；不使用镜像实现伪造结果。
