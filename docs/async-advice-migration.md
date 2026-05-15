# Async Advice Migration — `meteor-collection-hooks`

## The Problem

`meteor-collection-hooks` wraps `collection.update`, `collection.insert`, and
`collection.remove` with *advice* functions that run registered before/after hooks
around the real Mongo operation.

In Meteor 2.8+, every mutator method gained an async twin:
`updateAsync`, `insertAsync`, `removeAsync`. These go straight to the MongoDB
async driver and **never pass through the wrapped sync method** — so all registered
before/after hooks are silently skipped.

`keela-grapher` has added `*Async` helpers (`updateSelfAsync`, `modifySelfAsync`,
`insertOneAsync`, `removeOneAsync`, …) as direct async replacements for their sync
counterparts. Every caller that migrates from the sync helper to the async one
**loses all hooks** unless this package is fixed first.

The impact is concrete:


| Hook type                                           | What is skipped                                            |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `before.update` in `collection-schema.js`           | Schema validation, operator sanitization, field transforms |
| `after.update` in `one-to-one/many/many-to-many.js` | Grapher redundancy sync — denormalized data goes stale     |
| `after.update` in `notifications.js`                | In-app notifications don't fire                            |
| `after.update` in `mailchimp-sync.js`               | Mailchimp contact sync doesn't run                         |
| `after.update` in `google-calendar.js`              | Calendar sync doesn't run                                  |
| `after.insert` / `after.remove` hooks               | Same blind-spot for their async twins                      |


---

## Guiding Principle

> If a sync helper fires hooks, its `*Async` twin **must** also fire hooks.

`updateAsync` should mean "same semantics as `update`, but async". It must not
silently mean "also skip side effects". Any call site that migrates from `updateOne`
to `updateOneAsync` must observe identical hook behaviour.

---

## Where the Fix Lives

All changes are confined to **two files** in this package:

1. `collection-hooks.js` — intercept `collection.updateAsync` / `insertAsync` /
  `removeAsync` the same way the sync methods are already intercepted.
2. `update.js`, `insert.js`, `remove.js` — add a parallel async advice function for
  each operation that uses `await` instead of `Promise.await`.

No changes are needed in `keela-grapher` or any domain API file. Once the hooks
package is fixed, every `*Async` grapher helper gets hooks for free.

---

## Change 1 — `collection-hooks.js`

### Current code (lines 91–99 and 101–137)

The package already creates `self.direct.updateAsync` (the bypass path) but never
wraps `collection.updateAsync` with advice:

```js
// Already exists — direct bypass only
const asyncMethod = method + 'Async'
if (constructor.prototype[asyncMethod]) {
  self.direct[asyncMethod] = function (...args) {
    return CollectionHooks.directOp(function () {
      return constructor.prototype[asyncMethod].apply(self, args)
    })
  }
}

// Sync method IS wrapped with advice
collection[method] = function (...args) {
  if (CollectionHooks.directEnv.get() === true) {
    return _super.apply(collection, args)
  }
  return advice.call(this, CollectionHooks.getUserId(), _super, self, ...)
}
// ← asyncMethod is never wrapped here
```

### Required addition

Immediately after the sync wrapping block, add the async interception. The async
advice functions are registered via a new `defineAsyncAdvice` registry (see Change 2).

```js
// After the existing sync collection[method] = ... block:

const asyncAdvice = CollectionHooks.getAsyncAdvice(method)

if (asyncAdvice && constructor.prototype[asyncMethod]) {
  const _superAsync = collection[asyncMethod]          // original updateAsync / insertAsync / removeAsync

  // direct.updateAsync already registered above — unchanged

  // Wrap collection.updateAsync with async advice
  collection[asyncMethod] = async function (...args) {
    if (CollectionHooks.directEnv.get() === true) {
      return _superAsync.apply(collection, args)
    }
    return asyncAdvice.call(
      this,
      CollectionHooks.getUserId(),
      _superAsync,
      self,
      self._hookAspects[method] || {},
      function (doc) {
        return typeof self._transform === 'function'
          ? function (d) { return self._transform(d || doc) }
          : function (d) { return d || doc }
      },
      args,
      false
    )
  }
}
```

Also add the registry helpers alongside the existing `defineAdvice` / `getAdvice`:

```js
const asyncAdvices = {}

CollectionHooks.defineAsyncAdvice = (method, advice) => {
  asyncAdvices[method] = advice
}

CollectionHooks.getAsyncAdvice = method => asyncAdvices[method]
```

### `getDocs` needs an async twin

The current `getDocs` returns a cursor and calls `.fetch()` (sync). The async
advice functions need `await collection.find(...).fetchAsync()` instead. Add:

```js
CollectionHooks.getDocsAsync = async function getDocsAsync (
  collection, selector, options, fetchFields = {}, { useDirect = false } = {}
) {
  const findOptions = { transform: null, reactive: false, removed: true }

  if (Object.keys(fetchFields).length > 0) {
    findOptions.fields = fetchFields
  }

  if (options) {
    if (!options.multi) findOptions.limit = 1
    const { multi, upsert, ...rest } = options
    Object.assign(findOptions, rest)
  }

  return (useDirect ? collection.direct : collection)
    .find(selector, findOptions)
    .fetchAsync()
}
```

---

## Change 2 — `update.js`

Add `defineAsyncAdvice('update', ...)` alongside the existing `defineAdvice('update', ...)`.
The async version is structurally identical but:

- Every `.fetch()` call becomes `await .fetchAsync()`.
- Every `Promise.await(r)` becomes `await r`.
- The function is `async`.
- There is no callback-style (`async = typeof callback === 'function'`) branch —
`updateAsync` never takes a callback.

```js
import { EJSON } from 'meteor/ejson'
import { CollectionHooks } from './collection-hooks'

const isEmpty = a => !Array.isArray(a) || !a.length

CollectionHooks.defineAsyncAdvice('update', async function (
  userId, _super, instance, aspects, getTransform, args, suppressAspects
) {
  const ctx = { context: this, _super, args }
  let [selector, mutator, options] = args
  options = options || {}

  let docs
  let docIds
  let fields
  let abort
  const prev = {}

  if (!suppressAspects) {
    const shouldFetchForBefore = !isEmpty(aspects.before)
    const shouldFetchForAfter  = !isEmpty(aspects.after)
    let shouldFetchForPrevious = false

    if (shouldFetchForAfter) {
      shouldFetchForPrevious =
        Object.values(aspects.after).some(o => o.options.fetchPrevious !== false) &&
        CollectionHooks.extendOptions(instance.hookOptions, {}, 'after', 'update').fetchPrevious !== false
    }

    fields = CollectionHooks.getFields(args[1])
    const fetchFields = {}

    if (shouldFetchForPrevious || shouldFetchForBefore) {
      const afterAspectFetchFields  = shouldFetchForPrevious
        ? Object.values(aspects.after).map(o => (o.options || {}).fetchFields || {})
        : []
      const beforeAspectFetchFields = shouldFetchForBefore
        ? Object.values(aspects.before).map(o => (o.options || {}).fetchFields || {})
        : []
      const afterGlobal  = shouldFetchForPrevious
        ? (CollectionHooks.extendOptions(instance.hookOptions, {}, 'after',  'update').fetchFields || {})
        : {}
      const beforeGlobal = shouldFetchForPrevious
        ? (CollectionHooks.extendOptions(instance.hookOptions, {}, 'before', 'update').fetchFields || {})
        : {}
      Object.assign(fetchFields, afterGlobal, beforeGlobal, ...afterAspectFetchFields, ...beforeAspectFetchFields)
    }

    if (shouldFetchForBefore || shouldFetchForAfter) {
      // ← fetchAsync instead of fetch()
      docs   = await CollectionHooks.getDocsAsync.call(this, instance, args[0], args[2], fetchFields)
      docIds = docs.map(doc => doc._id)
    }

    if (shouldFetchForAfter) {
      prev.mutator = EJSON.clone(args[1])
      prev.options = EJSON.clone(args[2])
      if (shouldFetchForPrevious) {
        prev.docs = {}
        docs.forEach(doc => { prev.docs[doc._id] = EJSON.clone(doc) })
      }
    }

    // before — await each async hook
    for (const o of aspects.before) {
      for (const doc of docs) {
        const r = await o.aspect.call({ transform: getTransform(doc), ...ctx }, userId, doc, fields, mutator, options)
        if (r === false) abort = true
      }
    }

    if (abort) return 0
  }

  // Run the real updateAsync
  const affected = await _super.call(this, selector, mutator, options)

  // after
  if (!suppressAspects && !isEmpty(aspects.after)) {
    const afterFields   = CollectionHooks.getFields(args[1])
    const fetchFields   = {}
    const aspectFetchFields  = Object.values(aspects.after).map(o => (o.options || {}).fetchFields || {})
    const globalFetchFields  = CollectionHooks.extendOptions(instance.hookOptions, {}, 'after', 'update').fetchFields
    if (aspectFetchFields || globalFetchFields) {
      Object.assign(fetchFields, globalFetchFields || {}, ...aspectFetchFields.map(a => a.fetchFields))
    }

    // ← fetchAsync instead of fetch()
    const afterDocs = await CollectionHooks.getDocsAsync.call(
      this, instance, { _id: { $in: docIds } }, options, fetchFields, { useDirect: true }
    )

    for (const o of aspects.after) {
      for (const doc of afterDocs) {
        await o.aspect.call({
          transform: getTransform(doc),
          previous:  prev.docs && prev.docs[doc._id],
          affected,
          err: undefined,
          ...ctx
        }, userId, doc, afterFields, prev.mutator, prev.options)
      }
    }
  }

  return affected
})
```

**Key differences from the sync advice:**


| Sync `update.js`         | Async `updateAsync` advice              |
| ------------------------ | --------------------------------------- |
| `Promise.await(r)`       | `await r`                               |
| `.fetch()`               | `await .fetchAsync()`                   |
| `aspects.before.forEach` | `for...of` loop with `await`            |
| Callback-style branch    | Removed — `updateAsync` has no callback |
| `getDocs(...)`           | `getDocsAsync(...)`                     |


---

## Change 3 — `insert.js`

Same pattern. Replace:

- `Promise.await(r)` → `await r` in before hooks
- `.fetch()` → `await .fetchAsync()` for any doc lookups
- Callback branch removed — `insertAsync` always returns a Promise

```js
CollectionHooks.defineAsyncAdvice('insert', async function (
  userId, _super, instance, aspects, getTransform, args, suppressAspects
) {
  const ctx = { context: this, _super, args }
  let doc = args[0]
  let abort

  // before
  if (!suppressAspects) {
    for (const o of aspects.before) {
      const r = await o.aspect.call({ transform: getTransform(doc), ...ctx }, userId, doc)
      if (r === false) abort = true
    }
    if (abort) return
  }

  // Run the real insertAsync
  let id = await _super.call(this, doc)

  // Normalise id (same logic as sync advice)
  if (typeof id === 'object' && id.ops) {
    id = doc._id._str
      ? new Mongo.ObjectID(doc._id._str.toString())
      : id.ops && id.ops[0] && id.ops[0]._id
  }
  id = (id && id.insertedId) || (id && id[0] && id[0]._id) || id

  // after
  if (!suppressAspects) {
    doc = EJSON.clone(doc)
    doc._id = id
    const lctx = { transform: getTransform(doc), _id: id, err: undefined, ...ctx }
    for (const o of aspects.after) {
      await o.aspect.call(lctx, userId, doc)
    }
  }

  return id
})
```

---

## Change 4 — `remove.js`

```js
CollectionHooks.defineAsyncAdvice('remove', async function (
  userId, _super, instance, aspects, getTransform, args, suppressAspects
) {
  const ctx = { context: this, _super, args }
  const [selector] = args
  const prev = []
  let abort

  if (!suppressAspects) {
    if (!isEmpty(aspects.before) || !isEmpty(aspects.after)) {
      // ← fetchAsync
      const docs = await CollectionHooks.getDocsAsync.call(this, instance, selector)
      if (!isEmpty(aspects.after)) {
        docs.forEach(doc => prev.push(EJSON.clone(doc)))
      }

      // before
      for (const o of aspects.before) {
        for (const doc of docs) {
          const r = await o.aspect.call({ transform: getTransform(doc), ...ctx }, userId, doc)
          if (r === false) abort = true
        }
      }
    }
    if (abort) return 0
  }

  // Run the real removeAsync
  const result = await _super.call(this, selector)

  // after
  if (!suppressAspects) {
    for (const o of aspects.after) {
      for (const doc of prev) {
        await o.aspect.call({ transform: getTransform(doc), err: undefined, ...ctx }, userId, doc)
      }
    }
  }

  return result
})
```

---

## Change 5 — `advices.js`

Import the new async advice files alongside the existing ones:

```js
// Existing
import './insert.js'
import './update.js'
import './remove.js'
import './upsert.js'
import './find.js'
import './findone.js'

// New async advices — import after the sync ones
import './insert-async.js'
import './update-async.js'
import './remove-async.js'

import './users-compat.js'
```

> The async advice code can live in the same files as the sync advice (just call
> `defineAsyncAdvice` after `defineAdvice`), or in dedicated `*-async.js` files.
> Separate files make diffs and review cleaner.

---

## What does NOT change

- `**upsert.js**` — `upsertAsync` is not commonly called through the grapher helpers.
Add it if needed, but it is out of scope for the grapher `*Async` migration.
- `**find.js` / `findone.js**` — these return cursors / documents, not mutations.
Cursors already support `.fetchAsync()` at the caller level. No advice change needed.
- `**users-compat.js**` — unaffected.
- `**keela-grapher` files** — zero changes needed. Once this package is fixed, all
`updateOneAsync`, `insertOneAsync`, `removeOneAsync`, `updateSelfAsync`, etc. fire
hooks automatically.
- **Domain API files** — zero changes.

---

## Sequencing with the grapher `*Async` migration

This fix **must land and be deployed before** domain call sites are migrated from
sync helpers to async helpers. The risk otherwise:

```
Today (safe):
  task.updateSelf({ status: 'done' })
  → collection.update → hooks fire → grapher redundancies updated ✅

After naive async migration, before this fix:
  await task.updateSelfAsync({ status: 'done' })
  → collection.updateAsync → hooks skipped → grapher redundancies stale ❌

After this fix + async migration:
  await task.updateSelfAsync({ status: 'done' })
  → collection.updateAsync (wrapped) → async advice → hooks fire → redundancies updated ✅
```

Call sites that intentionally bypass hooks (e.g. cron jobs marking
`notification.isNotified`) should use `collection.direct.updateAsync(...)` instead of
`updateSelfAsync` to make the bypass explicit.

---

## Summary of files changed


| File                    | Change                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `collection-hooks.js`   | Add `asyncAdvices` registry; wrap `collection.updateAsync` / `insertAsync` / `removeAsync` with async advice; add `getDocsAsync` |
| `update-async.js` (new) | `defineAsyncAdvice('update', ...)` — async version of `update.js`                                                                |
| `insert-async.js` (new) | `defineAsyncAdvice('insert', ...)` — async version of `insert.js`                                                                |
| `remove-async.js` (new) | `defineAsyncAdvice('remove', ...)` — async version of `remove.js`                                                                |
| `advices.js`            | Import the three new async advice files                                                                                          |


