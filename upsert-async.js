import { EJSON } from 'meteor/ejson'
import { CollectionHooks } from './collection-hooks'

const isEmpty = a => !Array.isArray(a) || !a.length

CollectionHooks.defineAsyncAdvice('upsert', async function (userId, _super, instance, aspects, getTransform, args, suppressAspects) {
  // aspects = instance._hookAspects.upsert (upsert pointcuts only).
  // after.insert / after.update aspects are accessed from instance directly,
  // mirroring what the sync upsert advice receives as its full aspectGroup.
  const insertAspects = (instance._hookAspects && instance._hookAspects.insert) || {}
  const updateAspects = (instance._hookAspects && instance._hookAspects.update) || {}

  args[0] = CollectionHooks.normalizeSelector(instance._getFindSelector(args))

  const ctx = { context: this, _super, args }
  let [selector, mutator, options] = args
  options = options || {}

  let docs
  let docIds
  const prev = {}
  let abort

  if (!suppressAspects) {
    if (!isEmpty(aspects.before) || !isEmpty(updateAspects.after || [])) {
      docs = await CollectionHooks.getDocsAsync.call(this, instance, selector, options)
      docIds = docs.map(doc => doc._id)
    }

    if (!isEmpty(updateAspects.after || [])) {
      const shouldFetchPrevious =
        (updateAspects.after || []).some(o => o.options && o.options.fetchPrevious !== false) &&
        CollectionHooks.extendOptions(instance.hookOptions, {}, 'after', 'update').fetchPrevious !== false

      if (shouldFetchPrevious) {
        prev.mutator = EJSON.clone(mutator)
        prev.options = EJSON.clone(options)
        prev.docs = {}
        docs.forEach(doc => { prev.docs[doc._id] = EJSON.clone(doc) })
      }
    }

    for (const o of (aspects.before || [])) {
      const r = await o.aspect.call(ctx, userId, selector, mutator, options)
      if (r === false) abort = true
    }

    if (abort) return { numberAffected: 0 }
  }

  const ret = await CollectionHooks.directOp(() => _super.call(this, selector, mutator, options))

  if (!suppressAspects) {
    if (ret && ret.insertedId) {
      if (!isEmpty(insertAspects.after || [])) {
        const fetched = await CollectionHooks.getDocsAsync.call(this, instance, { _id: ret.insertedId }, {}, {})
        const doc = fetched[0]
        if (doc) {
          const lctx = { transform: getTransform(doc), _id: ret.insertedId, err: undefined, ...ctx }
          for (const o of (insertAspects.after || [])) {
            await o.aspect.call(lctx, userId, doc)
          }
        }
      }
    } else if (!isEmpty(updateAspects.after || [])) {
      const fields = CollectionHooks.getFields(mutator)
      const afterDocs = await CollectionHooks.getDocsAsync.call(
        this, instance, { _id: { $in: docIds } }, options, {}, { useDirect: true }
      )
      for (const o of (updateAspects.after || [])) {
        for (const doc of afterDocs) {
          await o.aspect.call({
            transform: getTransform(doc),
            previous: prev.docs && prev.docs[doc._id],
            affected: ret && ret.numberAffected,
            err: undefined,
            ...ctx
          }, userId, doc, fields, prev.mutator, prev.options)
        }
      }
    }
  }

  return ret
})
