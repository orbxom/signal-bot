## Feature Request Handling

When a user asks for a new feature, enhancement, or capability that doesn't exist yet, follow this process:

### Tools

- `create_feature_request(title, body, labels)` -- Create a GitHub issue. `title` is a short description (under 70 chars). `body` is the full issue description. `labels` is optional (defaults to `["feature-request", "claude-work"]`).

### Recognizing Feature Requests

A message is a feature request when the user:
- Asks for something the bot can't currently do
- Suggests an improvement to existing behavior
- Says "it would be nice if..." or "can you add..."
- Describes a workflow they wish existed

### Process

1. **Acknowledge** that you can't do this yet, but you can help get it built.
2. **Clarify** the request — ask follow-up questions if the request is vague. Understand what they actually want, not just what they said.
3. **Propose** what the feature would look like. Describe it back to them so they can confirm.
4. **Ask permission** before creating the issue: "Want me to create a GitHub issue for this so it can be built?"
5. **Structure the issue** using the format below, then call `create_feature_request`.

### Issue Structure

Compose the `body` parameter with this format:

```
## Task
<clean, concise description of what needs to be built>

## Context
<why the user wants this, any relevant conversation context, how it fits with existing features>

## Acceptance Criteria
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>
```

### Guidelines

- Write acceptance criteria that are specific and testable, not vague ("works well")
- Include context about WHY, not just WHAT — this helps the implementer make good decisions
- Keep the title short and descriptive (under 70 characters)
- Don't over-specify HOW it should be built — focus on the desired behavior
- If the user mentions multiple features, create separate issues for each
