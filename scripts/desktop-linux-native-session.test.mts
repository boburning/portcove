import { readLinuxX11Configuration } from "./desktop-linux-x11.mts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { launchLinuxNativeSession } from "../apps/desktop/scripts/desktop-linux-native-session.mts";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "namespace startup failure retains bounded actual stderr and cannot establish custody",
  {
    skip: process.platform !== "linux",
    timeout: 30_000,
  },
  async () => {
    const launch = await launchLinuxNativeSession("/usr/bin/true", [], {
      ...process.env,
      NODE_OPTIONS: "--portcove-no-such-option",
    });
    await assert.rejects(
      launch.ready(),
      /Native namespace startup was not acknowledged.*portcove-no-such-option/su,
    );
    await assert.rejects(launch.stop(), /Launch-bound namespace identity/u);
    assert.match(launch.receipt.startup_stderr, /portcove-no-such-option/u);
    assert.ok(launch.receipt.startup_stderr.length <= 4096);
    assert.notEqual(launch.receipt.exit.code, 0);
  },
);
async function counter(file) {
  try {
    return Number(await readFile(file, "utf8"));
  } catch {
    return 0;
  }
}
async function waitCounter(file, minimum = 0) {
  const until = Date.now() + 5000;
  while (true) {
    const value = await counter(file);
    if (Number.isFinite(value) && value > minimum) return value;
    assert.ok(Date.now() < until);
    await pause(20);
  }
}

test(
  "GTK picker binds the captured namespace and refuses unrelated processes and changed identities",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async () => {
    const launch = await launchLinuxNativeSession("/usr/bin/sleep", ["30"], process.env);
    const sentinel = spawn("/usr/bin/sleep", ["30"], { stdio: "ignore" });
    const sentinelJoin = new Promise((resolve) =>
      sentinel.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      await launch.ready();
      const helper = fileURLToPath(
        new URL("../apps/desktop/scripts/native-linux-folder-picker.py", import.meta.url),
      );
      const control = String.raw`
import hashlib, os, runpy, sys
from pathlib import Path
if hasattr(hashlib, 'file_digest'): delattr(hashlib, 'file_digest')
module = runpy.run_path(sys.argv[1])
OwnedLaunch, proc = module['OwnedLaunch'], module['proc']
pid, sentinel, nonce = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
started = proc(pid)['started']
with open('/usr/bin/sleep','rb') as f: digest = hashlib.sha256(f.read()).hexdigest()
for start, token in [(str(int(started)+1), nonce), (started, 'wrong-nonce')]:
    try: OwnedLaunch(pid,start,token,'/usr/bin/sleep',digest)
    except RuntimeError: pass
    else: raise AssertionError('Changed launch identity admitted')
owner = OwnedLaunch(pid,started,nonce,'/usr/bin/sleep',digest)
try:
    assert not owner.bind(sentinel), 'Unrelated sentinel admitted'
    pending, seen, candidates = [pid], set(), []
    while pending:
        current = pending.pop()
        assert len(seen) < 64
        if current in seen: continue
        seen.add(current)
        if Path(f'/proc/{current}/exe').resolve() == Path('/usr/bin/sleep').resolve(): candidates.append(current)
        pending.extend(int(x) for x in Path(f'/proc/{current}/task/{current}/children').read_text().split())
    assert len(candidates) == 1
    real_pidfd, real_proc, trace = os.pidfd_open, proc, []
    def traced_pidfd(target,*args):
        if target == candidates[0]: trace.append('pidfd')
        return real_pidfd(target,*args)
    def traced_proc(target):
        if target == candidates[0]: trace.append('proc')
        return real_proc(target)
    os.pidfd_open = traced_pidfd
    OwnedLaunch.bind.__globals__['proc'] = traced_proc
    try:
        assert owner.bind(candidates[0]), 'Owned descendant not admitted'
        assert trace.index('pidfd') < trace.index('proc'), 'Identity inspected before atomic pin'
        reads = [0]
        def changed_proc(target):
            state = real_proc(target)
            if target == candidates[0]:
                reads[0] += 1
                if reads[0] > 1: state['started'] = str(int(state['started'])+1)
            return state
        OwnedLaunch.bind.__globals__['proc'] = changed_proc
        assert not owner.bind(candidates[0]), 'Changed identity window admitted'
    finally:
        os.pidfd_open = real_pidfd
        OwnedLaunch.bind.__globals__['proc'] = real_proc
    class Variant:
        def unpack(self): return (sentinel,)
    class Connection:
        def call_sync(self,*args): return Variant()
    class GLib:
        Variant = staticmethod(lambda *args: None)
        class VariantType:
            new = staticmethod(lambda *args: None)
    class Gio:
        class DBusCallFlags: NONE = 0
    try: owner.recheck(Connection(),'owned',GLib,Gio)
    except RuntimeError: pass
    else: raise AssertionError('Changed accessibility peer admitted')
    assert Path(f'/proc/{sentinel}').exists(), 'Unrelated sentinel altered'
finally: owner.close()
bad = OwnedLaunch(pid,started,nonce,'/usr/bin/sleep','0'*64)
try: assert not bad.bind(candidates[0]), 'Changed executable digest admitted'
finally: bad.close()
print('owned GTK authority controls passed')
`;
      const result = spawnSync(
        "/usr/bin/python3",
        [
          "-c",
          control,
          helper,
          String(launch.child.pid),
          String(sentinel.pid),
          launch.receipt.nonce,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /owned GTK authority controls passed/u);
    } finally {
      const joined = await launch.stop();
      assert.equal(joined.quiesced, true);
      assert.equal(joined.exit.code, 0);
      sentinel.kill("SIGTERM");
      assert.equal((await sentinelJoin).signal, "SIGTERM");
    }
  },
);

test(
  "GTK chooser production guards bound queued reads and both button and text inputs",
  { skip: process.platform !== "linux" },
  () => {
    const helper = fileURLToPath(
      new URL("../apps/desktop/scripts/native-linux-folder-picker.py", import.meta.url),
    );
    const control = String.raw`
import ast, sys
from pathlib import Path
tree = ast.parse(Path(sys.argv[1]).read_text())
names = {'controls','bound_control','invoke','show_location'}
functions = [node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name in names]
assert len(functions) == 4
class Role:
    TABLE='table'; TREE='tree'; TREE_TABLE='tree-table'; LIST='list'
    PUSH_BUTTON='button'; TOGGLE_BUTTON='toggle'; TEXT='text'; ENTRY='entry'; FILE_CHOOSER='file-chooser'
class StateType:
    SENSITIVE='sensitive'; SHOWING='showing'; EDITABLE='editable'
class Atspi: pass
Atspi.Role, Atspi.StateType = Role, StateType
class State:
    def contains(self,state): return True
class Peer:
    def __init__(self,bus): self.bus_name=bus
class Node:
    def __init__(self,path='/chooser',bus='owned',parent=None,count=0,role='panel'):
        self.path=path; self.app=Peer(bus); self.parent=parent; self.count=count; self.role=role
        self.children=[]; self.reads=0; self.actions=0; self.writes=0
    def clear_cache(self): pass
    def get_role(self): return self.role
    def get_parent(self): return self.parent
    def get_state_set(self): return State()
    def get_child_count(self): return self.count
    def get_child_at_index(self,index):
        self.reads+=1
        return self.children[index] if self.children else Node(path=f'/child{index}',parent=self)
    def get_action_iface(self): return self
    def get_n_actions(self): return getattr(self,'action_count',1)
    def get_action_name(self,index): return 'show_location' if index==1 else 'other'
    def do_action(self,index): self.actions+=1; return True
    def get_editable_text_iface(self): return self
    def set_text_contents(self,text): self.writes+=1; return True
root=Node(count=2); large=Node('/large',parent=root,count=510)
root.children=[Node('/pending',parent=root),large]
scope={'Atspi':Atspi,'chooser':lambda:root,'window_path':'/chooser','bus_name':'owned'}
exec(compile(ast.Module(body=functions,type_ignores=[]),sys.argv[1],'exec'),scope)
try: scope['controls']()
except RuntimeError: pass
else: raise AssertionError('Queued inventory bound missing')
assert root.reads == 2 and large.reads == 0, 'Children read before queue budget'
root.count=0
foreign=Node('/button','foreign',root,role=Role.PUSH_BUTTON)
try: scope['invoke'](foreign)
except RuntimeError: pass
else: raise AssertionError('Foreign same-path button admitted')
assert foreign.actions == 0
owned=Node('/button',parent=root,role=Role.PUSH_BUTTON)
scope['invoke'](owned); assert owned.actions == 1
widget=Node('/widget',parent=root,role=Role.FILE_CHOOSER); widget.action_count=2
production_controls=scope['controls']
scope['controls']=lambda:[widget]
scope['show_location'](); assert widget.actions==1
widget.app=Peer('foreign')
try: scope['show_location']()
except RuntimeError: pass
else: raise AssertionError('Foreign location action admitted')
assert widget.actions==1
widget.app=Peer('owned'); widget.action_count=9
try: scope['show_location']()
except RuntimeError: pass
else: raise AssertionError('Unbounded location actions admitted')
assert widget.actions==1
widget.action_count=2
scope['controls']=lambda:[widget,widget]
try: scope['show_location']()
except RuntimeError: pass
else: raise AssertionError('Ambiguous location actions admitted')
assert widget.actions==1
scope['controls']=lambda:[widget]
original_action_count=widget.get_n_actions
counts=iter([2,0])
widget.get_n_actions=lambda:next(counts)
try: scope['show_location']()
except RuntimeError: pass
else: raise AssertionError('Changed location action count admitted')
assert widget.actions==1
widget.get_n_actions=original_action_count
original_action_name=widget.get_action_name
names=iter(['other','show_location','changed'])
widget.get_action_name=lambda index:next(names)
try: scope['show_location']()
except RuntimeError: pass
else: raise AssertionError('Changed location action name admitted')
assert widget.actions==1
widget.get_action_name=original_action_name
scope['controls']=production_controls
entry=Node('/entry','foreign',root,role=Role.ENTRY)
input_block=[node for node in ast.walk(tree) if isinstance(node,ast.If) and isinstance(node.test,ast.Name) and node.test.id=='directory']
assert len(input_block)==1
scope.update(directory=Path('/owned/input'),controls=lambda:[entry],button=lambda names:owned)
try: exec(compile(ast.Module(body=input_block,type_ignores=[]),sys.argv[1],'exec'),scope)
except RuntimeError: pass
else: raise AssertionError('Foreign same-path text admitted')
assert entry.writes == 0 and owned.actions == 1
entry.app=Peer('owned')
exec(compile(ast.Module(body=input_block,type_ignores=[]),sys.argv[1],'exec'),scope)
assert entry.writes == 1 and owned.actions == 2
print('GTK production input and inventory guards passed')
`;
    const result = spawnSync("/usr/bin/python3", ["-c", control, helper], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /GTK production input and inventory guards passed/u);
  },
);

test(
  "Linux native launches positively join detached descendants before independent restart",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async () => {
    const owned = await mkdtemp(path.join(os.tmpdir(), "portcove-native-namespace-control-"));
    const writer = path.join(owned, "writer.mjs");
    await writeFile(
      writer,
      `import {writeFileSync} from 'node:fs';let n=0;setInterval(()=>writeFileSync(process.argv[2],String(++n)),20);`,
    );
    const sentinelFile = path.join(owned, "foreign-sentinel");
    const sentinel = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import{writeFileSync}from'node:fs';let n=0;setInterval(()=>writeFileSync(process.argv[1],String(++n)),20);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
        sentinelFile,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const sentinelClosed = new Promise((resolve) =>
      sentinel.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      await waitCounter(sentinelFile);
      const receipts = [];
      for (const doubleFork of [false, true]) {
        const marker = path.join(owned, `writer-${doubleFork}`);
        const direct = `import{spawn}from'node:child_process';spawn(process.execPath,[${JSON.stringify(writer)},${JSON.stringify(marker)}],{detached:true,stdio:'ignore'}).unref();`;
        const program = doubleFork
          ? `import{spawn}from'node:child_process';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(direct)}],{detached:true,stdio:'ignore'}).unref();`
          : direct;
        const launch = await launchLinuxNativeSession(
          process.execPath,
          ["--input-type=module", "-e", program],
          process.env,
        );
        launch.child.stdout.resume();
        launch.child.stderr.resume();
        await launch.ready();
        await waitCounter(marker);
        const closed = await launch.stop();
        assert.equal(closed.quiesced, true);
        const sentinelBefore = await waitCounter(sentinelFile);
        const final = await counter(marker);
        await pause(200);
        assert.equal(await counter(marker), final);
        await waitCounter(sentinelFile, sentinelBefore);
        receipts.push(closed);
      }
      assert.notEqual(receipts[0].nonce, receipts[1].nonce);
      await writeFile(
        path.join(owned, "positive-join-receipts.json"),
        JSON.stringify(receipts, null, 2),
      );
      console.log(`Retained real namespace control receipts: ${owned}`);
    } finally {
      sentinel.stdin.end();
      assert.deepEqual(await sentinelClosed, { code: 0, signal: null });
    }
  },
);

test(
  "Linux native startup refusal cannot establish successful session closure",
  { skip: process.platform !== "linux", timeout: 20_000 },
  async () => {
    const launch = await launchLinuxNativeSession(
      "/portcove-owned-missing-native-driver",
      [],
      process.env,
    );
    launch.child.stdout.resume();
    launch.child.stderr.resume();
    await assert.rejects(launch.ready(), /ENOENT/u);
    await assert.rejects(launch.stop(), /normal successful init join/u);
    assert.equal(launch.receipt.ready.pid, 1);
    assert.equal(launch.receipt.exit.code, 126);
    assert.equal(launch.receipt.quiesced, undefined);
    const custody = await launch.custody();
    assert.equal(custody.quiesced, true);
    assert.equal(
      custody.exit.code,
      126,
      "Failed execution can join without becoming accepted qualification",
    );
  },
);

test(
  "Malformed private transport after readiness remains a failed qualification after real join",
  { skip: process.platform !== "linux", timeout: 20_000 },
  async () => {
    const launch = await launchLinuxNativeSession(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      process.env,
    );
    launch.child.stdout.resume();
    launch.child.stderr.resume();
    await launch.ready();
    // Deliberately corrupted parent transport; the decoder cannot inherit fd3.
    launch.child.stdio[3].emit(
      "data",
      Buffer.from('{"nonce":"wrong-nonce","kind":"driver-started","pid":99}\n'),
    );
    await assert.rejects(launch.stop(), /wrong-nonce/u);
    const custody = await launch.custody();
    assert.equal(custody.quiesced, true);
    assert.match(custody.protocol_error, /wrong-nonce/u);
  },
);

test("private-X11 configuration refuses missing prerequisites and undeclared authentication fields", async () => {
  const fs = await import("node:fs/promises");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pcv-x11-config-"));
  try {
    const file = path.join(temporary, "config.json");
    await fs.writeFile(
      file,
      JSON.stringify({ format_version: 1, stage: "hardware", harness_args: [] }),
    );
    await assert.rejects(readLinuxX11Configuration(file), /Unsupported/u);
    await fs.writeFile(
      file,
      JSON.stringify({
        format_version: 1,
        stage: "gtk",
        xvfb: path.join(temporary, "Xvfb"),
        xkbcomp: path.join(temporary, "xkbcomp"),
        output_root: temporary,
        harness_args: [],
        cookie: "must never capture",
      }),
    );
    await assert.rejects(readLinuxX11Configuration(file), /Unsupported/u);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
