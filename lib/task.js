var later = require('later'),
    util = require('util'),
    Promise = require('bluebird'),
    TaskEntry = require('./taskentry.js'),
    EventEmitter = require('events').EventEmitter,
    crone;

var Task = module.exports = function(_crone, config) {
    crone = _crone;

    Object.assign(this, {
        context: this,
        queue: 'default',
        minBackoffInterval: 0,
        maxBackoff: 60000,
        backoffIncrement: 5000,
        lockDuration: 300000,
        processInterval: 1000
    }, config || {});

    if (typeof this.name !== 'string' || this.name.length < 1) {
        throw new Error('Tasks must include a name.');
    }

    if (typeof this.run !== 'function') {
        throw new Error('Tasks must include a run() function.');
    }

    EventEmitter.call(this);
};

util.inherits(Task, EventEmitter);

// Convert a parsed schedule in the form:
//     {"schedules":[{"m":[0,15,30,45]}],"exceptions":[{"d":[3]}],"error":-1}
//
// to something more palatable as a Redis key:
//     m_0_15_30_45_exc_d_3
//
// As a practical matter, Redis can take any string as a key, but complex keys with colons
// make for messy human readability.
function keyForSchedule(parsedSchedule) {
    return JSON.stringify(parsedSchedule)
        .replace(/[^\w]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace('_schedules_', '')
        .replace('_error_1_', '')
        .replace('exceptions_', 'exc_');
}

/**
 * Schedule or reschedule this task.
 */
Task.prototype.scheduleTask = function() {
    var self = this;

    return Promise.try(function() {
        // See if we are meant to run on an interval
        self.parsedSchedule = null;
        if (this.schedule) {
            self.parsedSchedule = later.parse.text(this.schedule);
        } else if (this.cron) {
            self.parsedSchedule = later.parse.cron(this.cron);
        }

        // If not, we're done already - stand by until manually queued.
        if (!self.parsedSchedule) {
            return true;
        }

        // NOTE: We can't do !== -1 because CRON parsing doesn't set it:
        // > JSON.stringify(later.parse.cron('* */15 * * * *', true));
        // '{"schedules":[{"m":[0,15,30,45]}],"exceptions":[]}'
        // > JSON.stringify(later.parse.text('every 15 mins'));
        // '{"schedules":[{"m":[0,15,30,45]}],"exceptions":[],"error":-1}'
        if (self.parsedSchedule.error >= 0) {
            throw new Error('Invalid task schedule at char ' + self.parsedSchedule.error);
        }

        // See if a task entry is already scheduled for this task - use the schedule as the key
        var taskEntryKey = keyForSchedule(self.parsedSchedule);

        crone.logger('Next run: ' + later.schedule(self.parsedSchedule).next(1).schedule.next(2));
        self.emit('scheduled', self, taskEntry);

        var taskEntry = new TaskEntry();
        taskEntry.task = self;
        self.emit('before', self, taskEntry);
    });
};
