# Sidebar navigation example

This plugin replaces the bounded navigation controls above the thread list. BB
still owns the drawer, thread list, footer, resize handle, and shortcut policy.

The example shows each semantic navigation item in a compact grid. Each button
uses the host activation callback and the host split-drag binding. Search opens
the quick palette. The plugin does not create an inline search field.

Use **Use BB navigation** to render `experimental_Original`. Use **Test
fallback** to verify that a component crash restores the built-in controls.

```sh
bb plugin build examples/plugins/sidebar-navigation
bb plugin install examples/plugins/sidebar-navigation
```
