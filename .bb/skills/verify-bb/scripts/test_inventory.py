#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('inventory.py').resolve()
SKILL = Path('.bb/skills/verify-bb')


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bb-inventory-test-')
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        for page in (SCRIPT.parent.parent / 'features').glob('*.md'):
            self.write(str(SKILL / 'features' / page.name), page.read_text())
        sources = {
            'apps/cli/src/commands/project.ts': 'program.command("project");',
            'apps/cli/src/index.ts': 'export {};',
            'apps/app/src/lib/app-command-metadata.ts': 'command("thread.new", "New thread", "Start");',
            'apps/app/src/components/settings/settings-sections.ts': 'const sections = [{id: "general"}];',
            'packages/client-core/src/routes/route-paths.ts': 'export const APP_ROOT_ROUTE_PATH = "/";',
            'packages/domain/src/app-settings.ts': 'export const settings = {};',
            'packages/domain/src/experiments.ts': 'export const experiments = {};',
            'packages/server-contract/src/public-api.ts': 'defineRoute({path: "/projects", method: "get"});',
            'packages/plugin-sdk/src/index.ts': 'export {};',
            'apps/desktop/src/main.ts': 'export {};',
            'apps/mobile/app/index.tsx': 'export {};',
            'apps/web/src/routes/index.tsx': 'createFileRoute("/");',
            'apps/connect/src/worker.ts': 'export {};',
            'apps/demo-server/src/index.ts': 'export {};',
            'apps/server/src/index.ts': 'export {};',
            'scripts/bb-cloud-dev.mjs': 'export {};',
            'plugins/automations/package.json': json.dumps({'bb': {'server': './server.ts'}}),
            'plugins/automations/server.ts': 'bb.cli.register({name: "automation"});',
        }
        for name, content in sources.items():
            self.write(name, content)
        self.assertEqual(self.run_check('--write').returncode, 0)

    def write(self, name, content):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def run_check(self, *args):
        return subprocess.run(
            [str(SCRIPT), '--repo', str(self.repo), *args],
            capture_output=True, text=True, check=False,
        )

    def test_round_trip_and_behavior_drift(self):
        self.assertEqual(self.run_check().returncode, 0)
        self.write('apps/cli/src/commands/project.ts', 'program.command("project").option("--new-behavior");')
        changed = self.run_check()
        self.assertNotEqual(changed.returncode, 0)
        self.assertIn('Source drift', changed.stdout)
        self.assertIn('sourceDigest', changed.stdout)

    def test_new_command_is_visible(self):
        self.write('apps/cli/src/commands/project.ts', 'program.command("new-capability");')
        changed = self.run_check()
        self.assertNotEqual(changed.returncode, 0)
        self.assertIn('new-capability', changed.stdout)

    def test_unowned_plugin_cannot_be_baselined(self):
        before = (self.repo / SKILL / 'inventory.json').read_bytes()
        self.write('plugins/new-capability/package.json', '{"bb": {"server": "./server.ts"}}')
        self.write('plugins/new-capability/server.ts', 'export {};')
        result = self.run_check('--write')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('has no recipe', result.stderr)
        self.assertEqual((self.repo / SKILL / 'inventory.json').read_bytes(), before)

    def test_unmapped_cli_family_is_rejected(self):
        self.write('apps/cli/src/commands/new-family.ts', 'program.command("new-family");')
        result = self.run_check('--write')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unmapped CLI family', result.stderr)

    def test_missing_recipe_and_stale_catalog_fail(self):
        catalog = self.repo / SKILL / 'INVENTORY.md'
        catalog.write_text('stale')
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not match', result.stderr)
        self.assertEqual(self.run_check('--write').returncode, 0)
        (self.repo / SKILL / 'features/navigation.md').unlink()
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('has no recipe', result.stderr)

    def test_unlisted_recipe_is_rejected(self):
        self.write(str(SKILL / 'features/forgotten.md'), '# Forgotten feature\n')
        result = self.run_check('--write')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unlisted', result.stderr)


if __name__ == '__main__':
    unittest.main()
