import { EJSON } from 'meteor/ejson'
import { CollectionHooks } from './collection-hooks'

const isEmpty = a => !Array.isArray(a) || !a.length

CollectionHooks.defineAsyncAdvice('remove', async function (userId, _super, instance, aspects, getTransform, args, suppressAspects) {
  const ctx = { context: this, _super, args }
  const [selector] = args
  const prev = []
  let abort

  if (!suppressAspects) {
    if (!isEmpty(aspects.before) || !isEmpty(aspects.after)) {
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

  const result = await CollectionHooks.directOp(() => _super.call(this, selector))

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
