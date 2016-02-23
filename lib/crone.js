var later = require('later'),
    Promise = require('bluebird'),
    util = require('util'),
    shortid = require('shortid'),
    EventEmitter = require('events').EventEmitter,
    TaskEntry = require('./taskentry.js'),
    Redis = require('ioredis'),
    Lock = require('redislock'),
    redis,
    lock;

var Crone = module.exports = function(config) {
    if (!(this instanceof Crone)) {
        return new Crone(config);
    }

    Object.assign(this, config || {}, {
        redis: null,
        queues: ['default'],
        minBackoffInterval: 0,
        maxBackoff: 60000,
        backoffIncrement: 5000,
        lockDuration: 300000,
        processInterval: 1000
    });

    EventEmitter.call(this);

    this.runningJobs = [];
    this.scheduledJobs = [];
    this.registeredTasks = {};

    if (this.redis) {
        redis = new Redis(this.redis);
        lock = Lock.createLock(redis, { timeout: this.lockDuration });
    } else {
        throw new Error('Redis connection options required');
    }

    this._interval = null;

    // Generate unique worker ID and log a periodic heartbeat
    this.nodeId = shortid();
    lock.acquire('crone:workers:' + this.nodeId).then(function() {
        return lock.release();

    }).catch(function(e) {

    });

    // Periodically contribute to missing-worker queue cleanup
};

util.inherits(Crone, EventEmitter);

// Start the processing cycle
Crone.prototype._start = function() {
    if (!this._interval) {
        this._interval = setInterval(this._processJobs.bind(this), this.processInterval);
        this._interval.unref();
    }
};

// Stop the processing cycle
Crone.prototype._stop = function() {
    if (this._interval) {
        clearInterval(this._interval);
        this._interval = null;
    }
};

// Process jobs until the queue is empty
Crone.prototype._processJobs = function() {
    // We don't actually store the SCHEDULES in Redis - that's where node-resque had issues. Instead, all nodes know the
    // job schedules based on their defined task lists. Each node periodically reviews each queue it's configured to
    // handle, and adds job records.
};

/**
 * Register a task handler for future executions, with an optional schedule.
 * @param {Object} task The task definition to register. At a minimum, must include `name` and `run` elements.
 */
Crone.prototype.register = function(task) {
    var self = this;

    if (!task || typeof task.name !== 'string' || typeof !task.run !== 'function') {
        throw new Error('Invalid task definition.');
    }

    if (typeof task.name !== 'string' || typeof !task.run !== 'function') {
        throw new Error('Tasks require a name and run callback.');
    }

    this.registeredTasks[task.name] = task;

    console.log('Registered task ' + task.name);

    // If the task is to be run on a schedule, run it now at its next execution time. The de-dupe in the runner will prevent
    // overlapping executions in cluster start-ups. We skip the next scheduled execution to help with this.

    var schedule;
    if (task.schedule) {
        schedule = later.parse.text(task.schedule);
    } else if (task.cron) {
        schedule = later.parse.cron(task.cron);
    }

    if (schedule) {
        console.log('Next run: ' + schedule.next(2));
        self.emit('scheduled', task, {});

        var taskEntry = new TaskEntry();
        taskEntry.task = task;
        self.emit('before', task, taskEntry);
    }
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
