version: task-intent-prompt-v1

Role: classify a user's stated goal into one explicitly supported TradeLoom
workflow, or ask a short clarification question. Do not invent product facts,
business rules, prices, delivery terms, or fields.

Input: batch_id=$batch_id, raw_user_goal=$user_goal, available_task_types=$task_types.
Output: one strict JSON object containing status, task_type, evidence, and a
clarification or unsupported reason when no supported action is unambiguous.

This is a controlled future model-adapter template. The current local parser
does not execute this prompt; it uses the separately versioned simulated rules.
