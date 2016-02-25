var Promise = require('bluebird'),
    util = require('util'),
    shortid = require('shortid'),
    EventEmitter = require('events').EventEmitter,
    Task = require('./task.js'),
    TaskEntry = require('./taskentry.js'),
    Redis = require('ioredis'),
    Lock = require('redislock'),
    redis,
    lock;

var Crone = module.exports = function(config) {
    if (!(this instanceof Crone)) {
        return new Crone(config);
    }

    Object.assign(this, {
        redis: null,
        logger: console.log,
        queues: ['default'],
        nodeExpirationInterval: 30000,
        minBackoffInterval: 0,
        maxBackoff: 60000,
        backoffIncrement: 5000,
        lockDuration: 300000,
        processInterval: 1000
    }, config || {});

    EventEmitter.call(this);

    this.runningJobs = [];
    this.scheduledJobs = [];
    this.registeredTasks = {};

    if (this.redis) {
        // Use 'crone:' as a keyPrefix if the client hasn't supplied an override
        if (!this.redis.keyPrefix) {
            this.redis.keyPrefix = 'crone:';
        }

        redis = new Redis(this.redis);
        lock = Lock.createLock(redis, { timeout: this.lockDuration });
    } else {
        throw new Error('Redis connection options required');
    }

    this._interval = null;

    // Generate unique worker ID and log a periodic heartbeat
    this.nodeId = shortid();

    this._start();
};

util.inherits(Crone, EventEmitter);

// Start the processing cycle
Crone.prototype._start = function() {
    if (!this._interval) {
        this.logger('Crone: Starting node ' + this.nodeId);
        this._interval = setInterval(this._processJobs.bind(this), this.processInterval);
        this._interval.unref();
    }
};

// Stop the processing cycle
Crone.prototype._stop = function() {
    if (this._interval) {
        this.logger('Crone: Stopping node ' + this.nodeId);
        clearInterval(this._interval);
        this._interval = null;
    }
};

// Process jobs until the queue is empty
Crone.prototype._processJobs = function() {
    var self = this;

    self._updateHealthIndicator().then(function() {
        return self._cleanupExpiredNodes();

    }).then(function() {
        return Promise.map(self.queues, self._processQueue.bind(self));

    });

    // TODO: It would be nice to have a way to clean up old queues that we no longer use anywhere. But it's harder than it
    // sounds because we don't really know for sure the intentions of the developer. Maybe they're just not using a queue
    // today, because it's for some infrequent purpose - but they'll want it again tomorrow.
};

// Look for jobs to process in a single queue
Crone.prototype._processQueue = function(queue) {
    var self = this;

    self.logger('Processing queue', queue);
    redis.zrangebyscore(queue, 0, Date.now()).then(function(taskEntries) {
        if (!taskEntries) {
            return true;
        }

        // We don't store the actual task entries in this direct
        self.logger('Queue entries', taskEntries);
        Promise.mapSeries(taskEntries, function(entry) {
            var taskEntry = new TaskEntry(entry);

            var taskEntry = JSON.parse(entry);


        });
    });
};

// Update our own health indicator
Crone.prototype._updateHealthIndicator = function() {
    return redis.zadd('nodes', Date.now(), this.nodeId);
};

// Assist with expired-node job cleanup
Crone.prototype._cleanupExpiredNodes = function() {
    return redis.zrangebyscore('nodes', 0, Date.now() - 30000).then(function(expiredNodes) {
        console.log('Expired nodes', expiredNodes);
        return Promise.map(expiredNodes || [], function(expiredNode) {
            console.log('Cleaning up expired node', expiredNode);
            lock.acquire('nodeCleanup').then(function() {
                console.log('Got lock for', expiredNode);
                return lock.release();

            }).catch(function() {
                console.log('Another node got the lock for', expiredNode);

            });
        });
    });
};

/**
 * Register a task handler for future executions, with an optional schedule.
 * @param {Object} definition The task definition to register. At a minimum, must include `name` and `run` elements.
 */
Crone.prototype.register = function(definition) {
    var task = new Task(this, definition),
        self = this;

    task.on('scheduled', function(task, taskEntry) {
        self.emit('scheduled', task, taskEntry);
    });

    this.logger('Registered task ' + task.name);
    this.registeredTasks[task.name] = task;

    task.scheduleTask();
};

/**
 * Manually execute a task.
 * @param {String} name The task to execute
 * @param {Object} [params] Optional. The parameters to include in the call.
 * @param {Object} [options] Optional. Settings to override Crone defaults for this task execution.
 * @returns {Promise|*}
 */
Crone.prototype.run = function(name, params, options) {
    var task = null,
        taskEntry = new TaskEntry();

    taskEntry.task = task;
    taskEntry.params = params;
    taskEntry.options = options;
    taskEntry.state = 'queued';

    this.emit('queued', task, taskEntry);
    console.log('queued', task, taskEntry);

    return Promise.resolve(true);
};

/**
 * Generate a list of pending tasks.
 * @returns {Promise|Array}
 */
Crone.prototype.list = function() {
    return Promise.resolve([]);
};
