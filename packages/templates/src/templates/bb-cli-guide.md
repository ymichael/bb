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
bb thread status <thread-id>                          # Show thread status and recent events
bb thread log <thread-id>                             # Show thread event log
bb thread output <thread-id>                          # Get the final output of a thread
```

Interacting:

```
bb thread tell <thread-id> "Please also add tests"    # Send a follow-up message
bb thread steer <thread-id> "Focus on the API first"  # Steer an active thread
bb thread stop <thread-id>                            # Stop an active thread
```

Ownership:

```
bb thread update <thread-id> --parent-thread <manager-id>   # Assign thread to a manager
bb thread update <thread-id> --clear-parent-thread           # Remove manager ownership
```

Lifecycle:

```
bb thread archive <thread-id>         # Archive a thread
bb thread unarchive <thread-id>       # Unarchive a thread
bb thread delete <thread-id>          # Delete permanently
```

Operations:

```
bb thread commit <thread-id>                          # Request an agent-driven commit
bb thread commit <thread-id> --message "feat: add X"  # Commit with a specific message
bb thread squash-merge <thread-id>                    # Request an agent-driven squash merge
bb thread promote <thread-id>                         # Promote a worktree to primary checkout
bb thread demote                                      # Demote the currently promoted thread
```

## Managers

```
bb manager hire [projectId]            # Hire a new manager for a project
bb manager show [projectId]            # Show the primary manager for a project
bb manager status <manager-id>         # Show manager status and managed threads
bb manager threads <manager-id>        # List threads managed by this manager
bb manager send <manager-id> "message" # Send a message to another manager
bb manager log <manager-id>            # Show manager event log
bb manager delete <manager-id>         # Delete a manager permanently
```

## Projects

```
bb project list                        # List all projects
bb project create --name "name" --root /path  # Create a project
bb project files <query>               # Search files in a project
```

## Other

```
bb status                              # Show current context (project, thread)
bb daemon health                       # Show daemon health and storage usage
bb daemon restart                      # Restart the daemon
```
