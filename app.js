const express = require('express');
const Router = require('express').Router;
const _ = require('lodash');
const request = require('request');
const csvParse = require( 'csv-parse' );
const through2 = require('through2');
const oboe = require('oboe');
const unzip = require('unzip-stream');
const morgan = require('morgan');
const toString = require('stream-to-string');

// matches:
// - MapServer/0
// - FeatureServer/13
// - MapServer/1/
const arcgisRegexp = /(Map|Feature)Server\/\d+\/?$/;

// if no source parameter was supplied, bail immediately
const preconditionsCheck = (req, res, next) => {
  if (!req.query.source) {
    res.status(400).type('text/plain').send('\'source\' parameter is required');
  } else {
    next();
  }

};

// determine the protocol, type, and compression to make decisions easier later on
const determineType = (req, res, next) => {
  const source = req.query.source;

  if (arcgisRegexp.test(source)) {
    req.query.protocol = 'ESRI';
    req.query.type = 'geojson';
  } else if (_.endsWith(source, '.geojson')) {
    req.query.protocol = 'http';
    req.query.type = 'geojson';
  } else if (_.endsWith(source, '.csv')) {
    req.query.protocol = 'http';
    req.query.type = 'csv';
  } else if (_.endsWith(source, '.zip')) {
    req.query.protocol = 'http';
    req.query.compression = 'zip';
  } else {
    req.query.protocol = 'unknown';
  }

  // if protocol is unknown, return a 400
  if (req.query.protocol === 'unknown') {
    res.status(400).type('text/plain').send('Unsupported type');
  } else {
    next();
  }

};

// if the request protocol, type, and compression match, continue on this route
// otherwise move on to the next route
const typecheck = (protocol, type, compression) => (req, res, next) => {
  if (req.query.protocol === protocol && req.query.type === type && req.query.compression === compression) {
    next();
  } else {
    next('route');
  }

};

// middleware that queries an Arcgis server for the first 10 records
const sampleArcgis = (req, res, next) => {
  request.get({
    uri: `${req.query.source}/query`,
    qs: {
      outFields: '*',
      where: '1=1',
      resultRecordCount: 10,
      resultOffset: 0,
      f: 'json'
    },
    json: true
  }, (err, response, body) => {
    if (response.statusCode !== 200) {
      let error_message = `Error connecting to Arcgis server ${req.query.source}`;
      error_message += `: ${body} (${response.statusCode})`;

      res.status(400).type('text/plain').send(error_message);

    }
    else {
      req.query.fields = response.body.fields.map(_.property('name'));
      req.query.results = response.body.features.map( _.property('attributes') );
      return next();
    }

  });

};

// middleware that requests and streams a .geojson file, returning up to the first
// 10 records
const sampleGeojson = (req, res, next) => {
  console.log(`requesting ${req.query.source}`);

  req.query.results = [];

  oboe(req.query.source)
    .node('features[*]', feature => {
      req.query.fields = _.keys(feature.properties);
      req.query.results.push(feature.properties);
    })
    .node('features[9]', function() {
      // bail after the 10th result.  'done' does not get called after .abort()
      //  so next() must be called explicitly
      // must use full function() syntax for "this" reference
      this.abort();
      next();
    })
    .fail((err) => {
      let error_message = `Error retrieving file ${req.query.source}`;
      error_message += `: ${err.body} (${err.statusCode})`;

      res.status(400).type('text/plain').send(error_message);

    })
    .done(() => {
      // this will happen when the list of results has been processed and
      // iteration still has no reached the 11th result, which is very unlikely
      next();
    });

};

// middleware that requests and streams a .csv file, returning up to the first
// 10 records
const sampleCsv = (req, res, next) => {
  console.log(`requesting ${req.query.source}`);

  // save off request so it can be error-handled and piped later
  const r = request(req.query.source);

  // handle catastrophic errors like "connection refused"
  r.on('error', (err) => {
    const error_message = `Error retrieving file ${req.query.source}: ${err.code}`;

    res.status(400).type('text/plain').send(error_message);

  });

  // handle normal responses (including HTTP errors)
  r.on('response', (response) => {
    if (response.statusCode !== 200) {
      // something went wrong so save up the response text and return an error
      toString(r, (err, msg) => {
        let error_message = `Error retrieving file ${req.query.source}`;
        error_message += `: ${msg} (${response.statusCode})`;

        res.status(400).type('text/plain').send(error_message);

      });

    } else {
      // otherwise everything was fine so pipe the response to CSV and collect records
      req.query.results = [];

      r.pipe(csvParse({
        skip_empty_lines: true,
        columns: true
      }))
      .pipe(through2.obj(function(record, enc, callback) {
        if (req.query.results.length < 10) {
          req.query.fields = _.keys(record);
          req.query.results.push(record);
          callback();
        } else {
          // there are enough records so end the stream prematurely, handle in 'close' event
          this.destroy();
        }

      }))
      .on('close', () => {
        // stream was closed prematurely
        next();
      })
      .on('finish', () => {
        // stream was ended normally
        next();
      });

    }

  });

};

// middleware that requests and streams a compressed .csv file, returning up
// to the first 10 records
const sampleZip = (req, res, next) => {
  console.log(`requesting ${req.query.source}`);

  request.get(req.query.source)
  .pipe(unzip.Parse())
  .on('entry', entry => {
    if (_.endsWith(entry.path, '.csv')) {
      req.query.type = 'csv';
      req.query.results = [];

      // process the .csv file
      entry.pipe(csvParse({
        skip_empty_lines: true,
        columns: true
      }))
      .pipe(through2.obj(function(record, enc, callback) {
        // must use full function() syntax for "this" reference
        if (req.query.results.length < 10) {
          req.query.fields = _.keys(record);
          req.query.results.push(record);
          callback();
        } else {
          // there are enough records so end the stream prematurely, handle in 'close' event
          this.destroy();
        }

      }))
      .on('close', () => {
        // stream was closed prematurely
        next();
      })
      .on('finish', () => {
        // stream was ended normally
        next();
      });

    }
    else if (_.endsWith(entry.path, '.geojson')) {
      req.query.type = 'geojson';
      req.query.results = [];

      oboe(entry)
        .node('features[*]', feature => {
          req.query.fields = _.keys(feature.properties);
          req.query.results.push(feature.properties);
        })
        .node('features[9]', function() {
          // bail after the 10th result.  'done' does not get called after .abort()
          //  so next() must be called explicitly
          // must use full function() syntax for "this" reference
          this.abort();
          next();
        })
        .done(() => {
          // this will happen when the list of results has been processed and
          // iteration still has no reached the 11th result, which is very unlikely
          next();
        });

    }
    else {
      // we're not interested in this file, so dispose of its contents
      entry.autodrain();
    }

  })
  .on('finish', () => {
    if (!req.query.type) {
      res.status(400).type('text/plain').send('Could not determine type from zip file');
    }
  });

};

// middleware that outputs the accumulated metadata, fields, and sample results
const output = (req, res, next) => {
  res.status(200).send({
    coverage: {},
    type: req.query.protocol,
    compression: req.query.compression,
    data: req.query.source,
    source_data: {
      fields: req.query.fields,
      results: req.query.results
    },
    conform: {
      type: req.query.type
    }
  });

  next();
};

module.exports = () => {
  const app = express();
  app.use(morgan('combined'));

  // setup a router that only handles Arcgis sources
  const arcgisRouter = express.Router();
  arcgisRouter.get('/fields', typecheck('ESRI', 'geojson'), sampleArcgis);

  // setup a router that only handles geojson files
  const geojsonRouter = express.Router();
  geojsonRouter.get('/fields', typecheck('http', 'geojson'), sampleGeojson);

  // setup a router that only handles csv files
  const csvRouter = express.Router();
  csvRouter.get('/fields', typecheck('http', 'csv'), sampleCsv);

  const zipRouter = express.Router();
  zipRouter.get('/fields', typecheck('http', undefined, 'zip'), sampleZip);

  app.get('/fields',
    preconditionsCheck,
    determineType,
    arcgisRouter,
    geojsonRouter,
    csvRouter,
    zipRouter,
    output
  );

  // expose testing UI
  app.use(express.static(__dirname + '/public'));

  return app;

};
