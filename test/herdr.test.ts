import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isHerdrActive, notifyHerdr, withHerdrBlocked, herdrOps } from "../herdr.ts";

test("isHerdrActive returns true only when HERDR_ENV is '1'", () => {
  const origEnv = process.env.HERDR_ENV;
  try {
    process.env.HERDR_ENV = "1";
    assert.equal(isHerdrActive(), true);

    process.env.HERDR_ENV = "0";
    assert.equal(isHerdrActive(), false);

    delete process.env.HERDR_ENV;
    assert.equal(isHerdrActive(), false);

    process.env.HERDR_ENV = "true";
    assert.equal(isHerdrActive(), false);
  } finally {
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});

test("notifyHerdr spawns herdr notification show with correct args and does not throw", () => {
  let spawnedArgs: any[] = [];
  let unrefCalled = false;
  let errorHandlerAttached = false;

  const origSpawn = herdrOps.spawn;
  try {
    herdrOps.spawn = ((cmd: string, args: string[], options: any) => {
      spawnedArgs.push({ cmd, args, options });
      const mockChild = new EventEmitter();
      (mockChild as any).unref = () => {
        unrefCalled = true;
      };
      const origOn = mockChild.on.bind(mockChild);
      mockChild.on = (event: string, listener: any) => {
        if (event === "error") errorHandlerAttached = true;
        return origOn(event, listener);
      };
      return mockChild as any;
    }) as any;

    notifyHerdr("Test Title", "Test Body");

    assert.equal(spawnedArgs.length, 1);
    assert.equal(spawnedArgs[0].cmd, "herdr");
    assert.deepEqual(spawnedArgs[0].args, [
      "notification",
      "show",
      "Test Title",
      "--body",
      "Test Body",
      "--sound",
      "request",
    ]);
    assert.deepEqual(spawnedArgs[0].options, { stdio: "ignore", detached: true });
    assert.ok(unrefCalled);
    assert.ok(errorHandlerAttached);
  } finally {
    herdrOps.spawn = origSpawn;
  }
});

test("notifyHerdr silently handles spawn errors", () => {
  const origSpawn = herdrOps.spawn;
  try {
    herdrOps.spawn = (() => {
      throw new Error("spawn failed");
    }) as any;

    // Should not throw
    assert.doesNotThrow(() => {
      notifyHerdr("Title", "Body");
    });
  } finally {
    herdrOps.spawn = origSpawn;
  }
});

test("withHerdrBlocked bypasses event emission when HERDR_ENV is not '1'", async () => {
  const origEnv = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;

  const events = new EventEmitter();
  const emitted: any[] = [];
  events.on("herdr:blocked", (payload) => emitted.push(payload));

  try {
    const result = await withHerdrBlocked(
      events,
      "Test Label",
      { title: "T", body: "B" },
      async () => "success"
    );

    assert.equal(result, "success");
    assert.equal(emitted.length, 0);
  } finally {
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});

test("withHerdrBlocked bypasses event emission when events is missing or invalid", async () => {
  const origEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  try {
    const res1 = await withHerdrBlocked(null, "Test", null, async () => 123);
    assert.equal(res1, 123);

    const res2 = await withHerdrBlocked({}, "Test", null, async () => 456);
    assert.equal(res2, 456);
  } finally {
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});

test("withHerdrBlocked emits active: true then active: false on completion when HERDR_ENV is '1'", async () => {
  const origEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  const events = new EventEmitter();
  const emitted: any[] = [];
  events.on("herdr:blocked", (payload) => emitted.push(payload));

  try {
    let fnExecuted = false;
    const result = await withHerdrBlocked(
      events,
      "Awaiting input",
      null,
      async () => {
        assert.deepEqual(emitted, [{ active: true, label: "Awaiting input" }]);
        fnExecuted = true;
        return "result-val";
      }
    );

    assert.ok(fnExecuted);
    assert.equal(result, "result-val");
    assert.deepEqual(emitted, [
      { active: true, label: "Awaiting input" },
      { active: false },
    ]);
  } finally {
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});

test("withHerdrBlocked guarantees active: false emission when wrapped fn throws", async () => {
  const origEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  const events = new EventEmitter();
  const emitted: any[] = [];
  events.on("herdr:blocked", (payload) => emitted.push(payload));

  try {
    await assert.rejects(
      async () => {
        await withHerdrBlocked(
          events,
          "Failing prompt",
          null,
          async () => {
            throw new Error("Prompt cancelled");
          }
        );
      },
      { message: "Prompt cancelled" }
    );

    assert.deepEqual(emitted, [
      { active: true, label: "Failing prompt" },
      { active: false },
    ]);
  } finally {
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});

test("withHerdrBlocked triggers notifyHerdr when notification is provided", async () => {
  const origEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  const origSpawn = herdrOps.spawn;
  const spawnedArgs: any[] = [];

  try {
    herdrOps.spawn = ((cmd: string, args: string[], options: any) => {
      spawnedArgs.push({ cmd, args, options });
      const mockChild = new EventEmitter();
      (mockChild as any).unref = () => {};
      return mockChild as any;
    }) as any;

    const events = new EventEmitter();
    await withHerdrBlocked(
      events,
      "Need input",
      { title: "Notification Title", body: "Notification Body" },
      async () => "done"
    );

    assert.equal(spawnedArgs.length, 1);
    assert.equal(spawnedArgs[0].args[2], "Notification Title");
    assert.equal(spawnedArgs[0].args[4], "Notification Body");
  } finally {
    herdrOps.spawn = origSpawn;
    if (origEnv !== undefined) {
      process.env.HERDR_ENV = origEnv;
    } else {
      delete process.env.HERDR_ENV;
    }
  }
});
