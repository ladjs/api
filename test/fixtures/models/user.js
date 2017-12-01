const mongoose = require('mongoose');

const User = new mongoose.Schema({
  display_name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 70
  }
});

module.exports = mongoose.model('User', User);
