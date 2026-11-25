# Workspace instruction truncation: reuse one UTF-8 encoding

Refs W17-B，无对应公开issue编号。会改 runtimeVersion。Android 未编译。

## Public path and scope

`dsh-agent-instructions` exposes `renderAgentInstructions` and
`loadBaselineInstructions`; its normal Agent pre-step consumer loads the same
files and rendering path. The default output budget is 65536 bytes per chain
and the default source-file cap is 1048576 bytes. A source exceeding the output
budget can enter `truncateToFit`, which binary-searches the retained byte count.

This change only reuses the UTF-8 Buffer within one `truncateToFit` call. The
original implementation encoded the same complete source for its initial empty
candidate and each midpoint. No file reads, touch collection, observation time,
version cache, chain precedence, or inbox publication semantics change. There is
no cross-call cache. Files that fit the full rendering bypass this function.

## Equivalence boundary

Let B be Buffer.from(file.content, 'utf8'). The file content is unchanged during
the synchronous rendering call. Each midpoint receives the same B as before.
The original full-fit branch still returns the original string, including any
lone UTF-16 units supplied to the public pure renderer. Only actual truncation
backs up over continuation bytes and decodes the retained Buffer prefix.

`originalBytes` is B.length, equal to the prior UTF-8 byteLength. Each candidate
still recomputes its actual includedBytes, renders the full framing and marker,
and applies the same byte-budget predicate. The low/high/mid transitions,
returned candidate, compact fallback, omission records, literal frame-body
escaping and loaded order therefore remain unchanged. This is an equal-step
argument, not a new claim that every budget predicate is globally monotone or
that the existing search finds a globally optimal prefix.

Private optional Buffer parameters are used only by this real synchronous
caller; other helper calls retain their original default encoding behavior.
No public interface, dependency, wire field, input policy or size limit changes.

## Evidence limits

This is a performance change, not a correctness repair. The same public golden
suite should pass on both baseline and candidate. Fixed real-LocalFS ABBA
measurements use 4096-byte and 131072-byte sources, each with three warm and five
measured calls per process. The truncated larger input improved in both orders,
but the untouched small-input control also improved: process/IO noise is
material, so the observed 40–50% larger-input difference is not wholly attributed
to this algorithm and is not a CPU percentage or all-scale guarantee. Preserve
all original samples and the separate single-call inspector evidence; do not
compare profiler-enabled baseline time directly with unprofiled candidate time.

No complete Host/Agent, remote model, PRoot, ARM or Android behavior was tested
by this evidence. No old Session content or persisted instruction baseline is
rewritten.
