import './insert.js'
import './update.js'
import './remove.js'
import './upsert.js'
import './find.js'
import './findone.js'

// Async advice — must be imported after sync advices so defineAsyncAdvice
// runs after defineAdvice for the same method name
import './insert-async.js'
import './update-async.js'
import './remove-async.js'
import './upsert-async.js'
import './findone-async.js'

// Load after all advices have been defined
import './users-compat.js'
