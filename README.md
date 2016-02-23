# Crone: A Redis-backed task queue and scheduler for NodeJS

> Yes... Another one...

There is a plethora of CRON/queue scheduler modules for NodeJS, but none solved my specific use cases as cleanly as I
hoped. Here are the alternatives I considered, along with their shortcomings:

* **Celery** - The gold standard for task queueing and scheduling in other environments, but adds heavy Python stack
 and message broker dependencies I wanted to avoid. Also, although there is a NodeJS module to interface with it,
 it's only for task queueing - you can't easily write task handlers in it.
* **Kue** - Great job queue but limited recurring-schedule functionality. Kue also requires explicit queue and job
 definition, and I was looking for something a bit more ad-hoc.
* **Bull** - Good job queue with a nice progress-indication feature, but no recurring-schedule support.
* **Bee-Queue** - Very lightweight and wicked-fast task queue, but no recurring-schedule support. 
* **Node-Jobs** - Nicely done job queue, Redis-backed with minimal other dependencies. However, it provides no recurring
 schedule functionality, and has not been maintained since 2014.
* **Agenda** - Well thought-out recurring-schedule task manager with some one-off job queueing support. However, it adds
 a MongoDB dependency I wanted to avoid, and only partially implements the cluster-operation concepts I was looking for.
* **Node-Resque** - Did just about everything I wanted - except work reliably. :( I used this module for two years in
 ActionHero frameworks and got a lot of mileage out of it. The main problem I had was with dealing with failed jobs.
 Despite implementing the retry/remove failed task facilities, there were always edge cases where I had stuck or failed
 jobs that were difficult to recover.
* **Node-Cron** - Good CRON-like scheduler, but no queueing support and lacks cluster management (locking) concepts.

## Crone Overview

Crone was designed to provide both task queueing (processing of individually-submitted tasks, with parameters, by
a cluster of one or more processing nodes) and recurring-schedule management. Queue management is implicit - queues
are created simply by submitting jobs to them. Recurring schedules are defined with a CRON-like syntax using the
excellent Later.js module, which allows very sophisticated schedules to be created, but are also idempotent - repeatedly
scheduling tasks with the same parameters will not create duplicate entries. This eliminates the need for a "master"
scheduling node, because every worker can load or reload the scheduled task list when it starts.

Crone clients and workers connect using a common client library:

```js
var Crone = require('crone'),
    crone = new Crone({
        // The URL may be any valid ioredis connection URI: 
        redisUrl: 'redis://1.2.3.4:6379/1'
    });
```

Crone job processors then register their (Promise-based) task handlers:

```js
crone.register({
    name: 'myTask',
    run: function(params) {
        console.log('Running myTask', params);
        return true;
    }
});
```

Tasks can have very sophisticated schedules:

```js
crone.register({
    name: 'myTask',
    context: someContextObject,
    schedule: 'at 10:15 am also at 5:15pm except on Tuesday',
    run: function(params) {
        // "this" is someContextObject. Tasks return Promises, to be resolved or rejected on completion/failure.
        return Promise.then(true);
    }
});
```

... or use CRON-style 'S M H DOM MO DOW' syntax for scheduling:

```js
crone.register({
    name: 'myTask',
    cron: '15 10 * * ? *',
    run: function(params) {
        return true;
    }
});
```

... or even be enqueued manually:

```js
crone.run('myTask', { ... params });
```

optionally with a delay before execution (ideal for debouncing, since Crone also provides duplicate-detection):

```js
crone.run('myTask', { ... params }, { delay: 60000 });
```

or at a specific date/time in the future:

```js
crone.run('myTask', { ... params }, { at: new Date(Date.now() + 60000) });
```

Scheduled tasks are de-duped by their names and schedules. They have no parameters unless called via `runTask`, although
`context` can be used to provide global parameters to them. Manually enqueued tasks are de-duped by their names and
parameters. However, in both cases, a key may be provided to identify duplicates:

```js
crone.run('myTask', { ... params }, { key: 'myTask:1:2' };
```

This allows fine-grained control over what is considered a duplicate. It is also more efficient, and is thus recommended
whenever possible.

Tasks can provide completion events to the caller:

```js
crone.run('myTask', { ... params }).then(function(result) {
    console.log('Successfully processed myTask: ', result);
}).catch(function(e) {
    console.log('Error processing myTask: ', e);
});
```

Note that because Crone was designed for cluster operation, results and errors are communicated via Pub/Sub mechanics
through Redis. That means they must be serializable - it is strongly recommended that results be simple objects, and
errors be simple strings. Complex data structures, particularly those that contain context, will not work properly.

Also, Crone was designed for reliable operation. Tasks are "locked" by default for 5 minutes. This default is configurable
in the Crone client connection, and also in the task definition:

```js
crone.register({
    name: 'myTask',

    // This is a short-lived task: Override the lock duration to 30s 
    lockDuration: 30000,
    
    // Tasks should return Promises, but may optionally return scalar values (as is common in Bluebird)
    run: function() { return true; }
});
```

Tasks that throw errors will be re-scheduled with a back-off interval. This defaults to 0 (immediate retry) and then
grows 5 seconds at a time for each failure up to a maximum delay of 60 seconds. These defaults can also be overridden:

```js
crone.register({
    name: 'myTask',

    // If this job fails, wait a minute before retrying. Thereafter, wait 2 minutes between retries.
    minBackoff: 60000,
    maxBackoff: 120000,
    backoffIncrement: 60000,
    run: function() { return true; }
});
```

However, although **tasks** are designed to operate reliably, there are fewer guarantees regarding routing responses
back to manual callers. If a caller terminates or restarts before a task completes, the new process no longer
has the context of a "pending call" and will not be triggered. Resolve/reject handlers in callers should thus be
used only for tasks like notifying waiting clients or logging results.

## Queues

Crone supports queue-based operation that provides fine-grained control over the priority of task execution. Queues
do not need to be defined ahead of time, and with no parameters, a queue called 'default' will be used for all tasks,
and all Crone clients will listen for and process tasks in that queue. This behavior may be altered by defining tasks
in specific queues:

```js
crone.register({
    name: 'lowPriorityTask',
    queue: 'low',
    run: function() { return true; }
});
```

Crone clients may then be configured to execute tasks only from specific queues:

```js
var crone = new Crone({
    // ... connection options ...
    queues: ['high', 'default', 'low']
});
```

or not at all:

```js
var crone = new Crone({
    // ... connection options ...
    queues: null
});
```

In the examples above, `lowPriorityTask` would run only on the first node, after all high- and default-priority
tasks were handled, and not at all on the second node. This is an ideal pattern if you want to have two clusters,
one of API nodes and one of Task processing nodes, and you don't want your API nodes processing tasks at all.
You can configure your API nodes to not handle any queues, but still be able to submit and query the status of
tasks.

If a task processing node is configured to monitor more than one queue, the order they are specified is the order
in which they will be handled. This means queue names themselves can be any value - it is not important to use
the actual word "high".

### Configuration Options

Crone provides a number of options that control its default behavior for all jobs within the connection object,
listed below with their default values:

```js
var Crone = require('crone'),
    crone = new Crone({
        // The Redis connection URI. This may be any valid URI that ioredis accepts. Note that only one Redis
        // connection may be specified, but you can easily connect to a cluster via Redis Sentinel or Redis Cluster.
        redisUrl: 'redis://1.2.3.4:6379/1'
        
        // By default, retry failed tasks immediately, then back off 5s at a time for each additional failure to a
        // maximum of 60s. All times specified in ms.
        minBackoffInterval: 0,
        maxBackoff: 60000,
        backoffIncrement: 5000,
        
        // Scheduled jobs are locked by default by their name:schedule hashes for 5 minutes. Manually executed
        // tasks are locked by their name:params hashes, where params is serialized from the task's parameters. 
        lockDuration: 300000
    });
```

### Client API

The Crone client provides the following methods:

#### Register a task

```js
crone.register({
    name: 'myTask',
    minBackoff: 60000,
    maxBackoff: 120000,
    backoffIncrement: 60000,
    lockDuration: 300000,
    context: { a: 1 },
    schedule: 'every 15 mins',
    run: function(params) {
        // This will log "{ a: 1 }, undefined" every 15 minutes. Scheduled tasks have "this" set to their "context"
        // value (set when the task is registered) and "params" will be undefined unless the task is later run manually. 
        console.log(this, params);
        return true;
    }
});
```

#### Execute a task manually

```js
// This will log "{ a: 1 }, { b: 2 }}" on whichever task node ends up executing this task
crone.run('myTask', { b: 2 });
});
```

#### Query the list of pending tasks (scheduled and manual/deferred)

```js
crone.list().then(function(pendingTasks) {
    pendingTasks.map(function(pendingTask) {
        var task = pendingTask.task,
            taskEntry = pendingTask.taskEntry;
        
        console.log('Pending: ' + task.name + ', params: ' + taskEntry.params +
            ', status: ' + taskEntry.status +
            ', next execution: ' + taskEntry.nextExecution);
    });
});
```

#### Cancel all pending tasks named 'myTask'

```js
crone.list().then(function(pendingTasks) {
    pendingTasks.map(function(pendingTask) {
        if (pendingTask.task.name === 'myTask') {
            console.log('Canceling: ' + task.name);
            pendingTask.cancel();
        }
    });
});
```

### Client Events

The Crone client is an `EventEmitter`, and provides a set of events that may be consumed to customize how its logging
and other behaviors are handled. Note that the client observes the presence of its listeners, and if there are none,
it provides default behavior (such as logging to Console).

#### Task scheduled (by the scheduler):

```js
crone.on('scheduled', function(task, taskEntry) {
    console.log('Crone: Scheduled ' + task.name + ', next execution: ' + taskEntry.nextExecution);
});
```

#### Task queued manually:

```js
crone.on('queued', function(task, taskEntry) {
    console.log('Crone: Queued ' + task.name + ' for execution, params: ' + JSON.stringify(taskEntry.params));
});
```

#### Before each task executes:

```js
crone.on('before', function(task, taskEntry) {
    console.log('Crone: Executing task ' + task.name + ', params: ' + JSON.stringify(taskEntry.params));
});
```

#### Successful execution:

```js
crone.on('success', function(task, taskEntry) {
    console.log('Crone: ' + task.name + ' succeeded, result: ' + taskEntry.result);
});
```

#### Failed execution:

```js
crone.on('fail', function(task, taskEntry) {
    console.log('Crone: ' + task.name + ' failed, result: ' + taskEntry.error);
});
```

#### Task finished (success or failure):

```js
crone.on('after', function(task, taskEntry) {
    console.log('Crone: Finished executing task ' + task.name + ', status: ' + taskEntry.status);
});
```

These events are intended primarily for logging, and reflect only those events occurring locally on each node in the
cluster. The contents of `task` and `taskEntry` should be considered private API data, and modifying them will produce
unpredictable behavior. 

## Release History

v0.0.1 - Initial release.
