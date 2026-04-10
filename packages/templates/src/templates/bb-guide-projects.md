---
kind: instruction
title: bb Guide — Projects
summary: Command reference for project CRUD and sources.
intent: Provide complete project command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Project commands

A project maps to a code repository. All threads belong to a project.

  bb project list                         List all projects
  bb project create --name "..." [options]
    --root <path>                         Project root path
    --repo-url <url>                      Repository URL
    --host <id>                           Default host

  bb project show <id>                    Show project details
  bb project update <id>                  Update a project
    --name <name>                         New name

  bb project delete <id>                  Delete project and all threads
    --yes                                 Skip confirmation

Sources:

  Projects can have multiple sources (paths or repos).

  bb project source add <projectId>       Add a source
    --path <path>                         Local path
    --repo-url <url>                      Repository URL
    --host <id>                           Host for this source
    --default                             Set as default source

  bb project source update <projectId> <sourceId>
    --path <path>
    --repo-url <url>
    --default

  bb project source delete <projectId> <sourceId>
