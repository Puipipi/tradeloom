'use strict'
require('./main.cjs').start().catch(() => require('electron').app.exit(1))
