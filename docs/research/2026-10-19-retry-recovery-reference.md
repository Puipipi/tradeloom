# Phase 4 重试与恢复参考结论（Task 16–17）

日期：2026-10-19  
批次：task16-17-recovery 设计准备  
范围：只读当前需求相关文档与 Django/PostgreSQL 工作流执行代码；本笔记不定义最终行为，不授权生产实现。

## 外部参考及与本需求相关的做法

- [Temporal Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)：用 MaximumAttempts 给重试设硬上限，次数包含首次执行；失败原因可判为不可重试并立即返回。可借鉴的是明确的 attempt 上限和分类策略，避免宽泛异常被不受限地重跑。
- [Temporal Python error handling best practices](https://github.com/temporalio/documentation/blob/main/docs/develop/python/best-practices/error-handling.mdx)：持久化 checkpoint 本身不能保证外部副作用至多执行一次；调用端仍需幂等。恢复时必须把“步骤状态已保存”和“外部调用确定只发生一次”分开判断。
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) 与 [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)：持久化状态/游标可让同一工作流身份从保存位置恢复；resume 会从被中断节点开始，因此同一被中断节点内、interrupt 之前的代码会再次执行，该节点的副作用应由调用端做幂等保护。
- [LangGraph retry implementation](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/pregel/_retry.py)：重试由异常与 retry policy 匹配，并受 max_attempts 限制；这支持“按已声明错误策略重试”的概念，不能把捕获所有异常等同于可重试。

以上只提炼这些来源与本批相关的机制，不复制源码或整段文档。

## 当前项目可直接复用的基础

- Django ORM 与 PostgreSQL 已持久化 WorkflowTask、SubTask、WorkflowStep、HumanReview、EventLog；WorkflowStep.attempt 已存在，幂等键在同一工作流内有条件唯一约束。无需为了记录步骤状态先引入新状态存储。
- dispatch_subtask() 在短事务中锁定 workflow/subtask、检查依赖和审核、写入 running Step 后提交事务，再调用 runtime；结果或失败另开事务保存。这种不把外部/耗时执行包在数据库事务里的边界可继续使用。
- record_workflow_event()、transition_workflow()、同工作流依赖检查、canonical SubTask.output_refs.result、Task 13a 的来源重核与 submitted 审核门禁，均可作为状态变更与审计的现有接缝。
- 已存在的 attempt 列当前只保存到单个 Step 行；一次业务步骤由 step_key=subtask:<id> 查找，dispatch 首次建 attempt=1。失败重放会命中旧行并返回子任务，而不会新建 attempt。Task 16 若要求历史保留，必须明确“每 attempt 一行或其他可查询历史”的数据表示；不能仅递增一个当前值却声称保留历史。当前 step_key 没有数据库唯一约束，幂等键唯一约束也意味着每次 attempt 应有不同幂等键或明确的新键策略。
- 当前任何捕获到的 Exception 都经 _record_failure() 将 SubTask 与 WorkflowTask 置为 failed；resume_task() 跳过 failed 子任务并拒绝 failed workflow。它们是实现有限重试/显式恢复前必须改动或包裹的行为边界，不能描述成已有 retry/recovery 能力。

## 采用与不采用

本批采用 Temporal 的有限 MaximumAttempts、首次执行计入次数、不可重试错误短路等策略概念；采用 LangGraph 的持久化游标、同一执行身份恢复和中断前副作用幂等提醒；采用按异常匹配 policy 的边界。实现仍可复用现有 Django/PostgreSQL 行锁、短事务、状态和事件记录，不需要复制其调度器。

本批不引入 Temporal 或 LangGraph 完整框架：当前执行对象是本地 Django 服务与数据库行，现有规模及能力未显示必须交由完整分布式 workflow runtime 管理；引入会替换/叠加现有状态、调度及部署模型，超过 Task 16–17 的目标。也不增加大框架依赖。

## 本批已定案

每个 SubTask 最多三次 attempt（首次加两次），只允许显式单次 retry；仅 RetryableExecutionError 和安全 runtime 明确声明可重试。旧执行的中断接管保存 outcome_unknown；只能对显式声明支持安全重试的 runtime 发起后续尝试。attempt 保留为多条 WorkflowStep 历史，各自使用新幂等键并保存内部 result_snapshot；回放必须返回所命中键对应的历史 Step，并校验 retry_of_step_id。完整 Temporal/LangGraph runtime 与新大依赖不纳入本批。
