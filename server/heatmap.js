var NodeGeocoder = require('node-geocoder');

var options = {
  provider: 'google',
  // Optional depending on the providers
  httpAdapter: 'https', // Default
  apiKey: 'AIzaSyAwkxTe-EXtfrahmP8L0fdPGH83tDP9jkg', // for Mapquest, OpenCage, Google Premier
  formatter: null         // 'gpx', 'string', ...
};

// var dburl = 'mongodb://localhost:27017/crime-data';
var dburl = 'mongodb://heroku_66scqnxq:cgumfgro1nqv0tqmbbahdj1l79@ds019966.mlab.com:19966/heroku_66scqnxq';
var geocoder = NodeGeocoder(options);
var MongoClient = require('mongodb').MongoClient,
    assert = require('assert');

var crimeThreshold = function(object) {
  for (var key in object)
  {
      this[key] = object[key];
  }
};

const lat_min = 33.29;
const lat_max = 33.92;
const lng_min = -112.33;
const lng_max = -111.92;
const delta = 0.01;
const lng_per_row = Math.round((lng_max - lng_min)/delta);
const lat_per_col = Math.round((lat_max - lat_min)/delta);
const matrix_points = lng_per_row * lat_per_col;

var pointsArray = [];

var buildHeatmap = function(db, callback){
  pointsArray = [];
  MongoClient.connect(dburl, function(err, db) {
    assert.equal(null, err);
    console.log("Building heatmap");

    var records = db.collection('records');
    var heatmap = db.collection('heatmap');

    // Find all crimes near here
    var dist = 0.01;

    // Start with clean collections
    heatmap.remove({});

    for (var lat = 0; lat < lat_per_col; lat++) {
      for (var lng = 0; lng < lng_per_row; lng++) {
        for (var hour = 0; hour < 24; hour++) {
          var pointHeatMap = {
            loc : [lng_min + lng*delta, lat_min + lat*delta],
            time: hour,
            score: 0,
            crimeType: {},
            dayOfWeek: [0,0,0,0,0,0,0]
          };
          pointsArray.push(pointHeatMap);
        }
      }
    }

    var datemin = new Date();
    var datemax = new Date("1/1/1971");
    console.log("lng_per_row = " + lng_per_row + ", lat_per_col = " + lat_per_col + ", matrix points = " + matrix_points);
    records.find({dateTime: {$ne: ""}}).toArray(function(err, docs){
      for (var i = 0; i < docs.length; i++) {
        var dateTime = docs[i].dateTime.split(/\s+/);
        var date = dateTime[0].split(/\//);
        var day = new Date(dateTime[0]);

        if (datemin > day)
          datemin = day;
        if (datemax < day)
          datemax = day;

        var time = dateTime[1].split(/:/);
        var hour = parseInt(time[0]);

        // For now each crime in this circle is equal regardless of type or age
        var lat_floor = Math.floor(docs[i].latitude * 100)/100;
        var lng_floor = Math.floor(docs[i].longitude * 100)/100;
        var idx = Math.round((lng_per_row * (lat_floor - lat_min)/delta) + (lng_floor - lng_min)/delta);
        //console.log("lat: " + docs[i].latitude + ", lng: " + docs[i].longitude + ", lat_floor: " + lat_floor + ", lng_floor: " + lng_floor + ",  idx: " + idx);

        if (idx >= 0 && idx <= lng_per_row * lat_per_col - lng_per_row - 2) {
          addCrimeToHeatMap(idx, hour, docs[i].crimeType, day.getUTCDay());
        }
      } //for docs
      var pointsRemoved = 0;
      for (var i = matrix_points - 1; i >= 0; i--) {
        var removePoint = true;
        var idxArray = i * 24; // index constant for each point
        var idxPoint = idxArray; // index checks all hours for each point
        for (var j = 0; j < 24; j++) {
          if (pointsArray[idxPoint++]["score"] > 0) {
            removePoint = false;
            break;
          }
        }
        if (removePoint == true) {
          pointsArray.splice(idxArray, 24);
          pointsRemoved++;
        }
      }
      console.log("Removed " + pointsRemoved + " empty points, remaining points: " + pointsArray.length/24);
      // Produce csv files of heatmaps
      for (var i = 0; i < 24; i++) {
        var csvFile = "heatmap" + (i < 10? "0"| "") + i + ".csv";
        var file = new File(csvFile);
        file.open("w");
        file.writeln("lat,lng,time,score");
        var idx = i;
        for (var j = 0; j < pointsArray.length/24) {
          file.writeln(pointsArray[idx].loc[1] + "," + pointsArray[idx].loc[0] + "," + i + "," + pointsArray[idx].score);
          idx += 24;
        }
        file.close();
      }
      var file = new File("heatmap00.csv");
      file.open("r");
      var str = file.readln();
      file.close();
      console.log(str);
      
      heatmap.insertMany(pointsArray).then(function(res) {
        console.log(res.insertedCount + " new records have been inserted into the database");
        assert.equal(null, err);
        console.log("Calculating stats");
        var stats = db.collection('stats');
        stats.remove({});
        var num = res.insertedCount;
        // Compute stats for the whole city, store in another collection
        var statsObject = {};

        if (num > 0) {
          heatmap.find().sort( {"score": -1}).limit(1).toArray(function(err,docs){
            statsObject.maxScore = docs[0]["score"];

            // Store info about how many days are included in records & heatmap
            var start = Math.floor( datemin.getTime() / (3600*24*1000)); //days as integer from..
            var end = Math.floor( datemax.getTime() / (3600*24*1000)); //days as integer from..
            statsObject.datasetNumDays = end - start;
            // Define high crime as more than 1 crime for this hour per ~square mile per 10 days
            statsObject.highThreshold = statsObject.datasetNumDays/10;
            // Define low crime as less than 1 crime for this hour per ~square mile per 20 days
            statsObject.lowThreshold = statsObject.datasetNumDays/20;
            console.log("Dataset number of days = " + statsObject.datasetNumDays + ", Max score = " + statsObject.maxScore +
                              ", High threshold = " + statsObject.highThreshold + ", low threshold = " + statsObject.lowThreshold);

            stats.insertOne(statsObject);
          });
        } else {
          console.log("Unable to create stats collection");
        }
      });
    });
  });
};

function addCrimeToHeatMap(idx,hour,crimeType,dayOfWeek) {
  incScoreAndCrimeType(idx,hour,crimeType,dayOfWeek);
  incScoreAndCrimeType(idx+1,hour,crimeType,dayOfWeek);
  incScoreAndCrimeType(idx+lng_per_row,hour,crimeType,dayOfWeek);
  incScoreAndCrimeType(idx+lng_per_row+1,hour,crimeType,dayOfWeek);
}

function incScoreAndCrimeType(x,hour,crimeType,weekday){
  //console.log("Index " + x + " at time " + hour);
  var y = x*24+hour;
  pointsArray[y].score++;

  if (!pointsArray[y]["crimeType"][crimeType]) {
    pointsArray[y]["crimeType"][crimeType] = 0;
  }
  pointsArray[y]["crimeType"][crimeType] += 1;
  pointsArray[y].dayOfWeek[weekday]++;

  //console.log("score = " + pointsArray[x].timedata[hour]["score"] +
  //  ", crimeType " + crimeType + " = " + pointsArray[x].timedata[hour]["crimeType"][crimeType]);
}

var calcData = function(arg, callback){
  // Check if we are in Phoenix
/*
  geocoder.reverse({lat:arg.lat, lon:arg.lng}, function(err, res) {
    console.log(res);
    if(res.indexOf("Phoenix") === -1) {
      console.log("Not in Phoenix");
      callback("Error");
    }
  });
*/
  MongoClient.connect(dburl, function(err, db) {
    assert.equal(null, err);
    console.log("Connected correctly to server");
    var heatmap = db.collection('heatmap');
    var stats = db.collection('stats');

    // Compute data about this point
    //var query =  {loc : { $near : [ parseFloat(arg.lng), parseFloat(arg.lat) ], $maxDistance: 0.02 }};
    //console.log(query);
    var lnglo = parseFloat(arg.lng) - delta * 0.71
    var lnghi = parseFloat(arg.lng) + delta * 0.71;
    var latlo = parseFloat(arg.lat) - delta * 0.71;
    var lathi = parseFloat(arg.lat) + delta * 0.71;
    var queryPoint =  {"loc.0" : {$gt: lnglo, $lt: lnghi}, "loc.1" : {$gt: latlo, $lt: lathi}};
    console.log(queryPoint);
    heatmap.find(queryPoint,{},{}).toArray(function(err, docs){
      //var pointHeatmap = interpolateHeatmap(docs);
      var info = {time: [], timeOfDay: [0,0,0,0,0,0], dayOfWeek: [0,0,0,0,0,0,0], types: {}};
      for (var i = 0; i < 24; i++){
        info.time[i] = {score: 0, risk: "LOW", guess: "NONE"};
      }
      if (docs === undefined || docs.length == 0){
        // no crimes reported nearby
        console.log("No crimes reported nearby");
        console.log(info);
        callback({heatmap: info});
      } else {
        console.log(docs.length + " records accessed for risk assessment");
        // compare to thresholds
        stats.find().toArray(function(err,crimeStats){
          console.log("Dataset number of days = " + crimeStats[0].datasetNumDays + ", Max score = " + crimeStats[0].maxScore +
                  ", High threshold = " + crimeStats[0].highThreshold + ", low threshold = " + crimeStats[0].lowThreshold);

          var crimeTypeArray = [];

          for (var i = 0; i < 24; i++){
            crimeTypeArray[i] = {};
          }
          for (var i = 0; i < docs.length; i++) {
            // add to score
            info.time[docs[i].time].score += docs[i].score;
            info.timeOfDay[parseInt(docs[i].time/4)] += docs[i].score;
            for (var j = 0; j < 7; j++) {
              info.dayOfWeek[j] += docs[i].dayOfWeek[j];
            }

            // add to crime type
            for (var inst in docs[i].crimeType){
              if ( crimeTypeArray[docs[i].time][inst] === undefined )
              {
                  crimeTypeArray[docs[i].time][inst] = 0;
              }
              crimeTypeArray[docs[i].time][inst] += docs[i].crimeType[inst];
            }
          }
          for (var i = 0; i < 24; i++){
            // compute risk based on score
            info.time[i].score /=  docs.length/24;
            if (info.time[i].score < crimeStats[0].lowThreshold)
              info.time[i].risk = "LOW";
            else if (info.time[i].score  < crimeStats[0].highThreshold)
              info.time[i].risk = "MEDIUM";
            else
              info.time[i].risk = "HIGH";

            // compute guess based on crimeType weighting
            var max = 0;
            for (var inst in crimeTypeArray[i]){
              if (crimeTypeArray[i][inst] > max) {
                max = crimeTypeArray[i][inst];
                info.time[i].guess = inst;
              }
              if ( info.types[inst] === undefined )
              {
                  info.types[inst] = 0;
              }
              info.types[inst] += crimeTypeArray[i][inst];
            }

            if (info.time[i].guess === undefined) {
              info.time[i].guess = "NONE";
            }
          }
          console.log(info);
          callback({precog: info});
        });
      }
    });
  });
};


/*
function generateHeatMapFusion(){
  for (var lat = lat_min; lat < lat_max; lat += delta*5) {
    for (var lng = lng_min; lng < lng_max; lng += delta*5) {
      var query = { "loc.0": {$gte: lng, $lt: lng+delta*5}, "loc.1": {$gte: lat, $lt: lat+delta*5}};
      count = heatmap.find(query).count();
      lowRiskScoreThreshold = heatmap.find(query).sort({"score": 1}).skip(count/3).limit(1).toArray()[0].score;
      highRiskScoreThreshold = heatmap.find(query).sort({"score": -1}).skip(count/3).limit(1).toArray()[0].score;
      thresholdStats.push(new crimeThreshold({"loc": [lng,lat], "lowThreshold": lowRiskScoreThreshold, "highThreshold": highRiskScoreThreshold}));
      maxScore = heatmap.find(query).sort({"score": -1}).limit(1).toArray()[0].score;
    }
  }
  //console.log("Area threshold (" + lat + "," + lng + "): low = " + lowRiskScoreThreshold + ", high = " + highRiskScoreThreshold + ", max = " + maxScore);
}
*/

module.exports.buildHeatmap = buildHeatmap;
module.exports.calcData = calcData;
//module.exports.calcStats = calcStats;
