import { EJSON } from 'meteor/ejson'
import { CollectionHooks } from './collection-hooks'

const isEmpty = a => !Array.isArray(a) || !a.length

CollectionHooks.defineAsyncAdvice('update', async function (userId, _super, instance, aspects, getTransform, args, suppressAspects) {
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
    const shouldFetchForAfter = !isEmpty(aspects.after)
    let shouldFetchForPrevious = false

    if (shouldFetchForAfter) {
      shouldFetchForPrevious =
        Object.values(aspects.after).some(o => o.options.fetchPrevious !== false) &&
        CollectionHooks.extendOptions(instance.hookOptions, {}, 'after', 'update').fetchPrevious !== false
    }

    fields = CollectionHooks.getFields(args[1])
    const fetchFields = {}

    if (shouldFetchForPrevious || shouldFetchForBefore) {
      const afterAspectFetchFields = shouldFetchForPrevious
        ? Object.values(aspects.after).map(o => (o.options || {}).fetchFields || {})
        : []
      const beforeAspectFetchFields = shouldFetchForBefore
        ? Object.values(aspects.before).map(o => (o.options || {}).fetchFields || {})
        : []
      const afterGlobal = shouldFetchForPrevious
        ? (CollectionHooks.extendOptions(instance.hookOptions, {}, 'after', 'update').fetchFields || {})
        : {}
      const beforeGlobal = shouldFetchForPrevious
        ? (CollectionHooks.extendOptions(instance.hookOptions, {}, 'before', 'update').fetchFields || {})
        : {}
      Object.assign(fetchFields, afterGlobal, beforeGlobal, ...afterAspectFetchFields, ...beforeAspectFetchFields)
    }

    if (shouldFetchForBefore || shouldFetchForAfter) {
      docs = await CollectionHooks.getDocsAsync.call(this, instance, args[0], args[2], fetchFields)
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

    // before — await each hook in sequence so mutations to doc/modifier are visible to the next hook
    for (const o of aspects.before) {
      for (const doc of docs) {
        const r = await o.aspect.call({ transform: getTransform(doc), ...ctx }, userId, doc, fields, mutator, options)
        if (r === false) abort = true
      }
    }

    if (abort) return 0
  }

  const affected = await _super.call(this, selector, mutator, options)

  if (!suppressAspects && !isEmpty(aspects.after)) {
    const afterFields = CollectionHooks.getFields(args[1])
    const fetchFields = {}
    const aspectFetchFields = Object.values(aspects.after).map(o => (o.options || {}).fetchFields || {})
    const globalFetchFields = CollectionHooks.extendOptions(instance.hookOptions, {}, 'after', 'update').fetchFields
    if (aspectFetchFields || globalFetchFields) {
      Object.assign(fetchFields, globalFetchFields || {}, ...aspectFetchFields.map(a => a.fetchFields))
    }

    const afterDocs = await CollectionHooks.getDocsAsync.call(
      this, instance, { _id: { $in: docIds } }, options, fetchFields, { useDirect: true }
    )

    for (const o of aspects.after) {
      for (const doc of afterDocs) {
        await o.aspect.call({
          transform: getTransform(doc),
          previous: prev.docs && prev.docs[doc._id],
          affected,
          err: undefined,
          ...ctx
        }, userId, doc, afterFields, prev.mutator, prev.options)
      }
    }
  }

  return affected
})
