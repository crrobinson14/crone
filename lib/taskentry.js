var TaskEntry = module.exports = function() {
    this.task = null;
    this.params = {};
};

/**
 * Cancel this task before its next execution (if possible).
 */
TaskEntry.prototype.cancel = function() {

};
