import { CollectionHooks } from './collection-hooks'

CollectionHooks.defineAsyncAdvice('findOne', async function (userId, _super, instance, aspects, getTransform, args, suppressAspects) {
  const ctx = { context: this, _super, args }
  const selector = CollectionHooks.normalizeSelector(instance._getFindSelector(args))
  const options = instance._getFindOptions(args)
  let abort

  if (!suppressAspects) {
    for (const o of aspects.before) {
      const r = await o.aspect.call(ctx, userId, selector, options)
      if (r === false) abort = true
    }

    if (abort) return
  }

  const doc = await _super.call(this, selector, options)

  if (!suppressAspects) {
    for (const o of aspects.after) {
      await o.aspect.call(ctx, userId, selector, options, doc)
    }
  }

  return doc
})
