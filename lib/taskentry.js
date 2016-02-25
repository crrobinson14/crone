var TaskEntry = module.exports = function(json) {
    this.task = null;
    this.params = {};

    if (json) {
        Object.assign(this, JSON.parse(json));
    }
};

/**
 * Cancel this task before its next execution (if possible).
 */
TaskEntry.prototype.cancel = function() {

};
