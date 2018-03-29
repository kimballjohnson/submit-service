const express = require('express');
const request = require('request');
const _ = require('lodash');
const toString = require('stream-to-string');
const csvParse = require( 'csv-parse' );
const through2 = require('through2');
const yauzl = require('yauzl');

const winston = require('winston');
const logger = winston.createLogger({
  level: 'debug',
  transports: [
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// make temp scoped to individual requests so that calls to cleanup affect only
// the files created in the request.  temp.track() cleans up on process exit
// but that could lead to lots of file laying around needlessly until the
// service eventually stops.  Initialize with .track() anyway in the case
// where the service errored out before manual cleanup in middleware fires.
// Additionally, don't make temp global and cleanup on each request since it
// may delete files that are currently being used by other requests.
function setupTemp(req, res, next) {
  res.locals.temp = require('temp').track();
  next();
};

const outputHandlers = {
  csv: respondWithCsv,
  geojson: respondWithGeojson
};

function isOutputFormatSupported(format) {
  return outputHandlers.hasOwnProperty(format);
}

function handleCatastrophicError(errorCode, res, file) {
  res.status(500).type('application/json').send({
    error: {
      code: 500,
      message: `Error retrieving file ${file}: ${errorCode}`
    }
  });

}

function responseIsPlainText(headers) {
  return _.startsWith(_.get(headers, 'content-type'), 'text/plain');
}

function handlePlainTextNonCatastrophicError(r, statusCode, res, file) {
  // convert response to a string and log/return
  toString(r, (err, msg) => {
    const errorMessage = `Error retrieving file ${file}: ${msg} (${statusCode})`;
    logger.info(`OpenAddresses metadata file: ${errorMessage}`);

    res.status(500).type('application/json').send({
      error: {
        code: 500,
        message: errorMessage
      }
    });

  });

}

// the error message isn't plain text, so just return the template + status code
function handleNonPlainTextNonCatastrophicError(statusCode, res) {
  const errorMessage = `Error retrieving file ${process.env.OPENADDRESSES_METADATA_FILE}: (${statusCode})`;

  logger.info(`OpenAddresses metadata file: ${errorMessage}`);

  res.status(500).type('application/json').send({
    error: {
      code: 500,
      message: errorMessage
    }
  });

}

// return the processed file contents as CSV
function respondWithCsv(res, entry, next) {
  // response object functions are chainable, so inline
  entry.pipe(res.
    status(200).
    type('text/csv').
    set('Content-Disposition', 'attachment; filename=data.csv')).on('finish', next);

}

// return the processed file contents as GeoJSON
function respondWithGeojson(res, entry, next) {
  // create a stream to write to
  const out = res.
    status(200).
    type('application/json').
    set('Content-Disposition', 'attachment; filename=data.geojson');

  // output the GeoJSON header
  out.write('{"type":"FeatureCollection","features":[');

  // keep track of the number of records for comma delimters
  let count = 0;

  // stream the .csv file, converting to JSON on the way 
  entry
  .pipe(csvParse({
    skip_empty_lines: true,
    columns: true
  }))
  .on('error', err => {
    const errorMessage = `Error parsing file ${entry.path}: ${err}`;
    logger.info(`/download: ${errorMessage}`);
    res.status(400).type('text/plain').send(errorMessage);
  })
  .pipe(through2.obj(function(record, enc, callback) {
    // convert the record to a GeoJSON point
    const point = {
      geometry: {
        type: 'Point',
        coordinates: [
          parseFloat(record.LON),
          parseFloat(record.LAT)
        ]
      },
      properties: _.omit(record, ['LON', 'LAT'])
    };

    callback(null, point);

  }))
  .pipe(through2.obj(function(point, enc, callback) {
    // if this isn't the first record, prefix the string with a comma
    if (count++ > 0) {
      out.write(',');
    }

    // stringify the point and output
    out.write(JSON.stringify(point));

    callback();

  }))
  .on('finish', () => {
    // output the GeoJSON footer
    out.write(']}');
    res.end();
    next();
  });

}

function preconditionsCheck(req, res, next) {
  req.query.format = _.defaultTo(req.query.format, 'csv');

  if (!process.env.OPENADDRESSES_METADATA_FILE) {
    // if OPENADDRESSES_METADATA_FILE isn't available, then bail immediately
    res.status(500).type('application/json').send({
      error: {
        code: 500,
        message: 'OPENADDRESSES_METADATA_FILE not defined in process environment'
      }
    });

  } else if (!isOutputFormatSupported(req.query.format)) {
    // if format parameter is not 'csv' or 'geojson', bail immediately
    logger.debug('rejecting request due to invalid `format` parameter');
    res.status(400).type('application/json').send({
      error: {
        code: 400,
        message: `Unsupported output format: ${req.query.format}`
      }
    });

  } else {
    res.locals.outputHandler = outputHandlers[req.query.format];
    logger.debug({ format: req.query.format });
    next();

  }

};

// retrieve sources (files or directories) on a path
function getMetaData(req, res, next) {
  // save off request so it can be error-handled and piped later
  const r = request(process.env.OPENADDRESSES_METADATA_FILE);

  res.locals.source = req.baseUrl.replace('/download/', '');

  // handle catastrophic errors like "connection refused"
  r.on('error', err => handleCatastrophicError(err.code, res, process.env.OPENADDRESSES_METADATA_FILE));

  // handle normal responses (including HTTP errors)
  r.on('response', response => {
    if (response.statusCode !== 200) {
      // if the content type is text/plain, then use the error message text
      if (responseIsPlainText(response.headers)) {
        handlePlainTextNonCatastrophicError(r, response.statusCode, res, process.env.OPENADDRESSES_METADATA_FILE);
      }
      else {
        handleNonPlainTextNonCatastrophicError(res);
      }

    } else {
      logger.debug(`OpenAddresses metadata file: successfully retrieved ${process.env.OPENADDRESSES_METADATA_FILE}`);

      // otherwise everything was fine so pipe the response to CSV and collect records
      r.pipe(csvParse({
        delimiter: '\t',
        skip_empty_lines: true,
        columns: true
      }))
      .on('error', err => {
        const errorMessage = `Error retrieving file ${res.locals.source.data}: ${err}`;
        logger.info(`/download: ${errorMessage}`);
        res.status(400).type('text/plain').send(errorMessage);
      })
      .pipe(through2.obj(function(record, enc, callback) {
        if (record.source === res.locals.source) {
          res.locals.datafile = record.processed;
          this.destroy();
        } else {
          callback();
        }

      }))
      .on('close', () => {
        logger.debug('/download: stream ended prematurely');
        next();
      })
      .on('finish', () => {
        logger.debug('/download: stream ended normally');
        next();
      });

    }

  });

}

// retrieve latest run for source as .zip file
function getData(req, res, next) {
  if (!res.locals.datafile) {
    const errorMessage = `Unable to find ${res.locals.source} in ${process.env.OPENADDRESSES_METADATA_FILE}`;
    logger.info(`OpenAddresses metadata file: ${errorMessage}`);

    // if the requested source was not found in the OA results metadata, respond with error 
    res.status(400).type('application/json').send({
      error: {
        code: 400,
        message: errorMessage
      }
    });

  } else {
    const r = request(res.locals.datafile);
    let csvFileFound = false;

    // handle catastrophic errors like "connection refused"
    r.on('error', err => handleCatastrophicError(err.code, res, res.locals.datafile));

    // handle normal responses (including HTTP errors)
    r.on('response', response => {
      if (response.statusCode !== 200) {
        // if the content type is text/plain, then use the error message text
        handlePlainTextNonCatastrophicError(r, response.statusCode, res, res.locals.datafile);

      } else {
        const tmpZipStream = res.locals.temp.createWriteStream();

        // write the response to a temporary file
        r.pipe(tmpZipStream).on('close', (err) => {
          logger.debug(`wrote ${tmpZipStream.bytesWritten} bytes to ${tmpZipStream.path}`);

          yauzl.open(tmpZipStream.path, {lazyEntries: true}, (err, zipfile) => {
            if (err) {
              const errorMessage = `Error retrieving file ${res.locals.source.data}: ${err}`;
              logger.info(`/download: ${errorMessage}`);
              res.status(400).type('text/plain').send(errorMessage);

            } else {
              // read first entry
              zipfile.readEntry();

              zipfile.on('entry', (entry) => {
                zipfile.readEntry();

                // output the first .csv file found (there should only ever be 1)
                if (_.endsWith(entry.fileName, '.csv') && !csvFileFound) {
                  zipfile.openReadStream(entry, (err, stream) => {
                    // the CSV file has been found so just pipe the contents to response
                    csvFileFound = true;

                    // call the response handler according to output format
                    res.locals.outputHandler(res, stream, next);

                  });

                } else {
                  // this is a file that's currently unsupported so drain it so memory doesn't get full
                  logger.debug(`/download: skipping ${entry.fileName}`);

                }

              });

              // handle end of .zip file
              zipfile.on('end', () => {
                if (!csvFileFound) {
                  logger.info(`/download: ${res.locals.datafile} does not contain .csv file`);
                  res.status(500).type('application/json').send({
                    error: {
                      code: 500,
                      message: `${res.locals.datafile} does not contain .csv file`
                    }
                  });
                }

                next();
              });

            }

          });

        });

      }
    });

  }

}

// middleware that cleans up any temp files that were created in the course
// of the request
function cleanupTemp(req, res, next) {
  if (!res.headersSent) {
    res.locals.temp.cleanup((err, stats) => {
      logger.debug(`temp clean up: ${JSON.stringify(stats)}`);
    });
  }
};

module.exports = express.Router()
  .get('/', [
    preconditionsCheck,
    setupTemp,
    getMetaData, 
    getData,
    cleanupTemp
  ]);
