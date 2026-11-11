---
ticket_refs:
  - electinfo/craft-agents#113
---

# Pi managed workspace command-hook policy

This review record follows the implementation and actual tests; it is not a backdated pre-mortem. The normal task helper created this isolated feature from canonical fork develop8b4929d5677926865cd20f47e1fef45be74b390d, preserving main26eb ancestry.

## Problem and assumptions

The managed Mac registration declares `.claude/craft-settings.json` as policy while `.claude/settings.json` is an empty SDK-discovery stub. The old Pi helper read only that stub. A private compiled397 counterexample allowed an outside Write without invoking managed hooks; that candidate is superseded and must not be activated.

WorkspaceHookContext remains trusted internal context and hook commands remain trusted user configuration. This is policy selection, not a new permission registry or sandbox. A valid existing active registration selects its exact workspace/policy path and digest. Missing, malformed or stale declared policy fails closed. Without enrollment, the legacy settings path remains unchanged, including the live healthy Linux D4 layout. No global SDK callback or SDK UUID requirement is added to Pi.

## Changes and negative controls

The helper reads the existing registration only to select the declared managed file; direct Pi session identity, command execution, environment sealing, deadline/cancellation and denial propagation remain unchanged. Both policy files stay user-owned. No auth/provider, SDK/vendor, remote image or live configuration change is part of this source repair.

The new self-contained fixture preserves the actual Mac48-command event/group/matcher layout with harmless command capture. It exercises selected managed commands and actual Pi pre-tool allow/deny responses, missing/malformed policy, stale or differently bound registration, unenrolled legacy selection and parent-environment immutability. It does not claim to execute every installed Core command or establish native managed-Mac acceptance.

## Actual validation and independent review

Initial new fixtures against the old helper reported2pass/6fail, including managed command capture and denial/missing-policy failures. A later environment-marker assertion strengthens the positive control. Final frozen helperbec55584a5af9ec247a28b3d61f221f49e269d48554e5e5764395e43ca674bad and testcabb23fef0e4d39b823a2afb65dad4c65c82bbcd82fa82f1061960437a00e333 passed29methods/61assertions across the new8 and existing21,3.82seconds, using established Bun1.3.14. Shared TypeScript typecheck also passed.

Root independently read the complete helper/test diff and ran the same29methods/61assertions successfully in3.83seconds. The first reviewer PATH invocation lacked Bun; using the existing exact binary corrected that setup failure without installation or source changes. Direct exact-head PR rebind follows normal publication of this prepared source.

A bounded read-only observation of the actual Linux D4 workspace found no managed receipt or Craft policy file, and legacy event counts8/39/2/1. No remote file was changed. Independent compiled successor work owns actual private Core-profile allow/deny tests and native post-activation acceptance; neither is falsely claimed by the source-unit totals. Evidence: instruction-refactor-evidence-20261104/pi-managed-policy-source-20261111 and local0158-pi-policy-successor-20261111.

## Rollback and delivery

Normal source revert restores the prior helper. Local staging must preserve the reviewed validator, SDK/vendor versions, backend and app identity; candidate397 is not a valid managed-Mac activation proof. Remote D4 remains untouched. Core1166 publication/immutable-manifest delivery is independent and retains priority.
