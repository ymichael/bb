---
kind: instruction
title: bb CLI Guide
summary: Reference guide for the bb command-line interface.
intent: Provide a practical command reference for agents, focusing on the commands most relevant to managing threads and coordinating work.
editingNotes: Keep examples concrete and workflow-oriented. This is used as a sub-template in the manager instructions. Focus depth on commands a manager uses regularly; list the rest briefly for awareness.
---

The `bb` CLI is the primary interface for managing threads and coordinating work.

Context variables are set automatically when running inside a thread environment:

- `BB_PROJECT_ID` — current project
- `BB_THREAD_ID` — current thread

Read-only commands (e.g., `show`, `list`, `log`) print which thread or project was resolved from these env vars.
Mutating commands (e.g., `commit`, `stop`, `archive`, `update`) require an explicit thread ID or the `--self` flag to target the current thread from `BB_THREAD_ID`.

## Threads

Spawning:

```
bb thread spawn --project <project-id> --prompt "Implement feature X"
bb thread spawn --project <project-id> --prompt "Fix bug Y" --parent-thread <manager-id>
bb thread spawn --project <project-id> --prompt "Review the changes" --environment <environment-id>
```

The `--parent-thread` flag makes the new thread a managed child of the specified manager.
The `--environment` flag attaches the new thread to an existing environment (e.g., another thread's worktree). This is useful for pipeline workflows where a review thread needs to see a coding thread's files.

Inspecting:

```
bb thread list --project <project-id>                 # List all threads in a project
bb thread list --project <project-id> --parent-thread <manager-id>  # List managed threads only
bb thread show <thread-id>                            # Show thread details
bb thread show <thread-id> --work-status              # Include git working-tree status
bb thread show <thread-id> --git-diff                 # Include git diff
bb thread show <thread-id> --merge-base-branches      # Include available merge-base branches
bb thread log <thread-id>                             # Show thread event log
bb thread log <thread-id> --format json --limit 50    # Raw events as JSON (paginated)
bb thread output <thread-id>                          # Get the final output of a thread
```

Interacting:

```
bb thread tell <thread-id> "Please also add tests"           # Send a follow-up message
bb thread tell <thread-id> "Focus on the API first" --mode steer  # Steer an active thread
bb thread stop <thread-id>                                   # Stop an active thread
bb thread stop --self                                        # Stop the current thread
```

Ownership:

```
bb thread update <thread-id> --parent-thread <manager-id>   # Assign thread to a manager
bb thread update <thread-id> --clear-parent-thread           # Remove manager ownership
bb thread update --self --title "New title"                  # Update the current thread
```

Lifecycle:

```
bb thread archive <thread-id>         # Archive a thread
bb thread archive --self              # Archive the current thread
bb thread unarchive <thread-id>       # Unarchive a thread
bb thread delete <thread-id>          # Delete permanently
```

Operations:

```
bb environment update <environment-id> --merge-base-branch <branch>   # Set the environment merge-base override
bb environment update <environment-id> --clear-merge-base-branch      # Clear the environment merge-base override
bb environment commit <environment-id>                                 # Create a commit in the environment
bb environment squash-merge <environment-id> --merge-base-branch <branch>  # Squash-merge the environment into the target branch
bb environment promote <environment-id>               # Promote an environment to primary checkout
bb environment demote <environment-id>                # Demote an environment from the primary checkout
bb environment promote-status --project <project-id>  # Show the active primary-checkout environment
```

## Managers

```
bb manager hire [projectId]            # Hire a new manager for a project
bb manager list [projectId]            # List managers for a project
bb manager status <manager-id>         # Show manager status and managed threads
bb manager delete <manager-id>         # Delete a manager permanently
```

Use `bb thread` commands for other manager interactions:

```
bb thread list --parent-thread <manager-id>  # List managed threads
bb thread tell <manager-id> "message"        # Message a manager
bb thread log <manager-id>                   # Show manager log
```

## Projects

```
bb project list                        # List all projects
bb project create --name "name" --root /path  # Create a project
bb project show <project-id>           # Show project details
bb project update <project-id> --name "new name"  # Update a project
bb project delete <project-id>         # Delete a project and all its threads
bb project files <query>               # Search files in a project
```

## Providers

```
bb provider list                       # List available providers
bb provider models [providerId]        # List available models (optionally filtered by provider)
```

## Other

```
bb status                              # Show current context (resolved project and thread IDs)
bb guide                               # Show the BB system overview and CLI guide
bb server health                       # Show server health and storage usage
bb server restart                      # Restart the server
```
