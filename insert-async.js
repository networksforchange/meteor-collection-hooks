import { EJSON } from 'meteor/ejson'
import { Mongo } from 'meteor/mongo'
import { CollectionHooks } from './collection-hooks'

CollectionHooks.defineAsyncAdvice('insert', async function (userId, _super, instance, aspects, getTransform, args, suppressAspects) {
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

  let id = await CollectionHooks.directOp(() => _super.call(this, doc))

  // Normalise the returned id — mirrors the same logic in insert.js
  if (typeof id === 'object' && id.ops) {
    if (doc._id && doc._id._str) {
      id = new Mongo.ObjectID(doc._id._str.toString())
    } else {
      id = id.ops && id.ops[0] && id.ops[0]._id
    }
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
