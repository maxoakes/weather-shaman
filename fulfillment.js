// See https://github.com/dialogflow/dialogflow-fulfillment-nodejs
// for Dialogflow fulfillment library docs, samples, and to report issues
'use strict';
'esversion: 9';
 
const functions = require('firebase-functions');
const {WebhookClient} = require('dialogflow-fulfillment');
const {Card, Suggestion} = require('dialogflow-fulfillment');

const axios = require('axios');
const key = "734dbd0d17ca58f96ed16bfdaac831b0";
const weekday = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
 
process.env.DEBUG = 'dialogflow:debug'; // enables lib debugging statements
 
exports.dialogflowFirebaseFulfillment = functions.https.onRequest((request, response) => {
  const agent = new WebhookClient({ request, response });
  console.log('Dialogflow Request headers: ' + JSON.stringify(request.headers));
  console.log('Dialogflow Request body: ' + JSON.stringify(request.body));
  function welcome(agent) {
    agent.add(`Welcome to my agent!`);
  }
 
  function fallback(agent) {
    agent.add(`I didn't understand`);
    agent.add(`I'm sorry, can you try again?`);
  }
    
  async function getWeatherIntentHandler(agent) {
    let output = await getWeatherFromParameters(
      agent.parameters.Condition,
      agent.parameters.Location,
      agent.parameters.DayTime);
    agent.add(output);
  }
  
  async function getForecastIntentHandler(agent) {
    let output = await getForecast(agent.parameters.Location, agent.parameters.DayCount);
    agent.add(output);
  }
  
  async function getForecastLimitIntentHandler(agent) {
    let output = await getForecastLimit(agent.parameters.Location,
                                   agent.parameters.Condition,
                                   agent.parameters.Limit,
                                   agent.parameters.DayCount);
    agent.add(output);
  }
  
  // Run the proper function handler based on the matched Dialogflow intent name
  let intentMap = new Map();
  intentMap.set('Default Welcome Intent', welcome);
  intentMap.set('Default Fallback Intent', fallback);
  intentMap.set('Get Weather Intent', getWeatherIntentHandler);
  intentMap.set('Get General Forecast Intent', getForecastIntentHandler);
  intentMap.set('Get Forecast Limits Intent', getForecastLimitIntentHandler);
  agent.handleRequest(intentMap);
});


/*
 *
 *  Primary Intent Functions
 *
*/

async function getWeatherFromParameters(conditionString, locationObject, dateString)
{
    //get the time specified from the input, or set the time to the current time if it is not specified
    let isCurrentWeather;
    let dateTime;
    if (!isFieldDefined(dateString))
    {
        isCurrentWeather = true;
        dateTime = Date.now();
    }
    else
    {
        isCurrentWeather = false;
        let utcDateString = dateString.date_time.substring(0,20) + "00:00"; //very nasty local to UTC conversion
        dateTime = new Date(utcDateString);
        if (Date.now() > dateTime)
        {
            isCurrentWeather = true;
            return Date.now();
        }
    }

    //perform the API call
    let apiData = await grabData(locationObject, isCurrentWeather);
    if (apiData === undefined)
    {
        return "Sorry, I couldn't find any weather information about that location. Try another one or be more specific with the location.";
    }
    let tz = (isFieldDefined(apiData.city)) ? apiData.city.timezone : apiData.timezone;

    let weather = {}; //object where all of the possibly needed data will be stored
    let target = apiData; //set the object that is being read initially
    
    //if the API has a 'count' field, this is a forecast API call that has future data at several times
    if (isFieldDefined(apiData.cnt))
    {
        //loop through all of the times to find the forecast that matches the requested date/time the best,
        //and choose that as the target
        let forecastFound = false;
        for (let i = 0; i < apiData.list.length; i++)
        {
            let d = new Date(apiData.list[i].dt*1000);
            if ((dateTime.getTime()-(tz*1000)) >= d) continue;
            else
            {
                target = apiData.list[i];
                forecastFound = true;
                break;
            }
        }
        if (!forecastFound)
        {
            //if no data is found, then the forecast is not in range for the API
            //the free version of this API can see only 5 days in the future
            return "Sorry, I cannot get a forecast that far into the future. Try 5 days or less.";
        }
        weather.location = apiData.location;
    }
    else
    {
        weather.location = target.location;
    }
    //fill the weather storage object with all of the possible data that we might need
    //also perform unit conversions and apply units
    weather.dt = new Date(target.dt*1000);
    weather.conditionID = target.weather[0].id;
    weather.description = target.weather[0].description;
    weather.temp = `${kToF(target.main.temp)} degrees`;
    weather.low = kToF(target.main.temp_min);
    weather.high = kToF(target.main.temp_max);
    weather.humidity = `${target.main.humidity}%`;
    weather.feels = `${kToF(target.main.feels_like)} degrees`;
    weather.pressure = `${Number(target.main.pressure*.02953).toFixed(2)} inMg`;
    weather.visibility = (target.visibility >= 10000) ? "greater than 10km" : `${target.visibility}m`;
    weather.clouds = `${target.clouds.all}%`;
    weather.windDir = getDirectionFromDegree(target.wind.deg);
    weather.windSpeed = `${Number(target.wind.speed * 2.237).toFixed(1)} mph`;
    weather.pop = (isFieldDefined(weather.pop)) ? `${target.pop*100}%` : "0%";
    weather.rain = target.rain;
    weather.snow = target.snow;
    if (target.wind.gust != undefined) weather.windGust = `${Number(target.wind.gust * 2.237).toFixed(1)} mph`;

    //a string to indicate if the weather data is for now or in the future (in an english sentence)
    let tense = {};
    if (isCurrentWeather)
    {
        tense.pos = "is";
        tense.neg = "is not";
    }
    else
    {
        tense.pos = "will be";
        tense.neg = "will not be";
    }

    let locationString = getLocationStringFromObject(weather.location);

    //construct a sentence with the information that the user asked for
    let resultString;
    switch (conditionString)
    {
        case "weather":
            if (isFieldDefined(weather.description) && isFieldDefined(weather.temp))
            {
                resultString = `The weather in ${locationString} ${tense.pos} ${weather.description} with a temperature of ${weather.temp}`;
            }
            else
            {
                resultString = `The weather for ${locationString} is unknown`;
            }
            break;
        case "temperature":
            if (isFieldDefined(weather.temp))
            {
                let tempString = `The temperature in ${locationString} ${tense.pos} ${weather.temp}`;
                let humidityString = ` with humidity at ${weather.humidity}`;

                //check if the high and low temps are working correctly
                //Sometimes they are the same as the current temp...
                if (weather.low != weather.high)
                {
                    resultString = `${tempString} with a low and high of ${weather.low} and ${weather.high} degrees${humidityString}`;
                }
                else
                {
                    resultString = `${tempString}${humidityString}`;
                }
            }
            else
            {
                resultString = `The temperature for ${locationString} is unknown`;
            }
            break;
        case "snow":
            if (isFieldDefined(weather.snow))
            {
                //sometimes it shows rates for 'per 1h' or 'per 3h'
                let rate;
                if ("1h" in weather.snow)
                {
                    rate = `${weather.snow["1h"]}mm per hour`;
                }
                else if ("3h" in weather.snow)
                {
                    rate = `${weather.snow["3h"]}mm per 3 hours`;
                }
                else
                {
                    rate = "unknown";
                }
                resultString = `It ${tense.pos} snowing at a rate of ${rate} in ${locationString}`;
            }
            else
            {
                resultString = `It ${tense.neg} snowing in ${locationString}`;
            }
            break;
        case "rain":
            if (isFieldDefined(weather.rain))
            {
                //sometimes it shows rates for 'per 1h' or 'per 3h'
                let rate;
                if ("1h" in weather.rain)
                {
                    rate = `${weather.rain["1h"]}mm per hour`;
                }
                else if ("3h" in weather.snow)
                {
                    rate = `${weather.rain["3h"]}mm per 3 hours`;
                }
                else
                {
                    rate = "unknown";
                }
                resultString = `It ${tense.pos} raining at a rate of ${rate} in ${locationString}`;
            }
            else
            {
                resultString = `It ${tense.neg} raining in ${locationString}`;
            }
            break;
        case "pressure":
            if (isFieldDefined(weather.pressure))
            {
                resultString = `The pressure in ${locationString} ${tense.pos} ${weather.pressure}`;
            }
            else
            {
                resultString = `The pressure for ${locationString} is unknown`;
            }
            break;
        case "visibility":
            if (isFieldDefined(weather.visibility))
            {
                resultString = `The visibility in ${locationString} ${tense.pos} ${weather.visibility}`;
            }
            else
            {
                resultString = `The visibility for ${locationString} is unknown`;
            }
            break;
        case "cloud cover":
            if (isFieldDefined(weather.clouds))
            {
                resultString = `The cloud coverage in ${locationString} ${tense.pos} ${weather.clouds}`;
            }
            else
            {
                resultString = `The cloud cover for ${locationString} is unknown`;
            }
            break;
        case "wind":
            if (isFieldDefined(weather.windSpeed))
            {
                //check if wind gusts are contained in the wind object, and if so, add them to the string
                if (weather.windSpeed < weather.windGust && isFieldDefined(weather.windGust))
                {
                    resultString = `The wind in ${locationString} ${tense.pos} ${weather.windDir} at ${weather.windSpeed} with gusts up to ${weather.windGust}`;
                }
                else
                {
                    resultString = `The wind in ${locationString} ${tense.pos} ${weather.windDir} at ${weather.windSpeed}`;
                }
            }
            else
            {
                resultString = `Wind information is unknown for ${locationString}`;
            }
            break;
        case "pop":
            if (isCurrentWeather)
            {
                //if it is currently percipitating
                if (isBetween(weather.conditionID, 300, 699) || isBetween(weather.conditionID, 200,202) || isBetween(weather.conditionID, 230, 232))
                {
                    resultString = `There is currently ${weather.description} in ${locationString}`;
                }
                else
                {
                    resultString = `There is currently ${weather.description} in ${locationString}`;
                }
            }
            else
            {
                resultString = `The chance of precipitation in ${locationString} will be ${weather.pop}`;
            }
            break;
    }

    //if this weather is for a specific time, make a string for that time,
    //otherwise, it is current weather and verbosity is not needed
    let timeString = "";
    if (!isCurrentWeather)
    {
        timeString = ` at ${readableDateTime(weather.dt, tz)}`;
    }
    return `${resultString}${timeString}.`;
}

async function getForecast(locationObject, numDays)
{
    if (!isBetween(numDays, 1, 5) && (numDays !== undefined && numDays != ""))
    {
        return "Sorry, I can only get a weather forecast within the next 5 days.";
    }
    let apiData = await grabData(locationObject, false, numDays);
    if (apiData === undefined)
    {
        return "Sorry, I couldn't find any weather information about that location. Try another one.";
    }
    let tz = (isFieldDefined(apiData.city)) ? apiData.city.timezone : apiData.timezone;

    let locationString = getLocationStringFromObject(apiData.location);
    //the api returns the objects in chronological order, no need to sort them again
    let forecast = [];
    for (let i = 0; i < apiData.list.length; i++)
    {
        let w = {};
        w.dt = new Date(apiData.list[i].dt*1000);
        w.temp = apiData.list[i].main.temp;
        w.id = apiData.list[i].weather[0].id;
        w.weather = apiData.list[i].weather[0].main;
        w.wind = apiData.list[i].wind.speed;
        w.pop = apiData.list[i].pop*100;
        forecast.push(w);
    }

    //get general weather info
    let weatherTrend = getWeatherOccuranceDurations(forecast);
    let weatherOccurances = getWeatherOccuranceCounts(forecast);

    //identify the two most common weather types
    let primaryWeatherType = Object.keys(weatherOccurances)[0];
    let secondaryWeatherType = Object.keys(weatherOccurances)[1];

    //find the longest duration of the most common weather type
    let longestTrendSegment = {};
    let longestDuration = 0;
    for (let i = 0; i < weatherTrend.length; i++)
    {
        if (weatherTrend[i].weather == primaryWeatherType && weatherTrend[i].duration >= longestDuration)
        {
            longestDuration = weatherTrend[i].duration;
            longestTrendSegment = weatherTrend[i];
        }
    }

    //get min and max of some weather info
    let low = {};
    low.temp = Number.POSITIVE_INFINITY;

    let high = {};
    high.temp = Number.NEGATIVE_INFINITY;

    let pop = {};
    pop.value = 0;

    for (let i = 0; i < forecast.length; i++)
    {
        if (forecast[i].temp < low.temp)
        {
            low.temp = forecast[i].temp;
            low.dt = forecast[i].dt;
        }
        if (forecast[i].temp > high.temp)
        {
            high.temp = forecast[i].temp;
            high.dt = forecast[i].dt;
        }
        if (forecast[i].pop > pop.value)
        {
            pop.value = forecast[i].pop;
            pop.dt = forecast[i].dt;
        }
    }
    
    //construct a string of all of the gathered info
    let tempString = ` Temperatures will get as low as ${kToF(low.temp)} degrees at ${readableDateTime(low.dt, tz)} and as high as ${kToF(high.temp)} degrees at ${readableDateTime(high.dt, tz)}.`;
    let popString = ` The highest chance of precipitation will be ${pop.value}% at ${readableDateTime(pop.dt, tz)}.`;

    let secondaryCondtion = "";
    if (secondaryWeatherType !== undefined)
    {
        secondaryCondtion = ` There will also be occasional ${secondaryWeatherType}.`;
    }
    let forecastString = `Between now and ${readableDateTime(forecast[forecast.length-1].dt, tz)} in ${locationString}, there will mainly be ${primaryWeatherType}, with the longest stretch between ${readableDateTime(longestTrendSegment.start, tz)} and ${readableDateTime(longestTrendSegment.end, tz)}.${secondaryCondtion}${tempString}${popString}`;
    return forecastString;
}

//get a general trend of the main weather and how long each weather event will last
//returns array of objects in the form {weather: string, start: Date, end: Date, duration, int}
function getWeatherOccuranceDurations(forecast)
{
    let durations = [];
    for (let i = 0; i < forecast.length; i++)
    {
        let conditionPhrase = idToPhrase(forecast[i].id);
        let t = {};
        if (durations.length == 0)
        {
            //start the weather occurance chain
            t.weather = conditionPhrase;
            t.start = forecast[i].dt;
            durations.push(t);
        }
        else
        {
            if (conditionPhrase == durations[durations.length-1].weather)
            {
                //if it is the same weather as the last two hours, move on
                continue;
            }
            else
            {
                //if the weather is different than the last two hours, mark an end time for the most recent weather type,
                //then start a weather occurance for this next type of weather
                durations[durations.length-1].end = forecast[i].dt;
                durations[durations.length-1].duration = (durations[durations.length-1].end - durations[durations.length-1].start)/(1000*60*60);
                t.weather = conditionPhrase;
                t.start = forecast[i].dt;
                durations.push(t);
            }
        }        
    }
    //filling the last entry that is not done by the loop
    durations[durations.length-1].end = forecast[forecast.length-1].dt;
    durations[durations.length-1].duration = (durations[durations.length-1].end - durations[durations.length-1].start)/(1000*60*60);
    return durations;
}

//counts of each weather occurance that happens in the next few days
//returns in the form {weatherType1: string, weatherType2: string ...}
function getWeatherOccuranceCounts(forecast)
{
    let counts = {};
    for (let i = 0; i < forecast.length; i++)
    {
        //count the occurance of each type of weather
        let conditionPhrase = idToPhrase(forecast[i].id);
        if (counts[conditionPhrase] === undefined) counts[conditionPhrase] = 1;
        else counts[conditionPhrase]++;      
    }

    //get the most common weather type
    const sorted = Object.entries(counts)
        .sort(([,a],[,b]) => b-a)
        .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});
    return sorted;
}

async function getForecastLimit(locationObject, conditionString, limitString, numDays)
{
    if (!isBetween(numDays, 1, 5) && isFieldDefined(numDays))
    {
        return "Sorry, I can only get weather information within the next 5 days.";
    }
    if (conditionString === "weather")
    {
        return "Sorry, could you ask for a more specific weather condition?";
    }
    let apiData = await grabData(locationObject, false, numDays);
    if (apiData === undefined)
    {
        return "Sorry, I couldn't find any weather information about that location. Try another one.";
    }
    let tz = (isFieldDefined(apiData.city)) ? apiData.city.timezone : apiData.timezone;
    let locationString = getLocationStringFromObject(apiData.location);
    let observedCondition = [];
    for (let i = 0; i < apiData.list.length; i++)
    {
        let c = {};
        c.dt = new Date(apiData.list[i].dt*1000);
        switch (conditionString)
        {
            case "snow":
                if (apiData.list[i].snow === undefined) c.value = 0;
                else c.value = apiData.list[i].snow['3h'];
                break;
            case "rain":
                if (apiData.list[i].rain === undefined) c.value = 0;
                else c.value = apiData.list[i].rain['3h'];
                break;
            case "pressure":
                c.value = apiData.list[i].main.pressure;
                break;
            case "visibility":
                c.value = apiData.list[i].visibility;
                break;
            case "cloud cover":
                c.value = apiData.list[i].clouds.all;
                break;
            case "wind":
                c.value = apiData.list[i].wind.speed;
                break;
            case "temperature":
                c.value = apiData.list[i].main.temp;
                break;
            case "pop":
                c.value = apiData.list[i].pop;
                break;
        }
        observedCondition.push(c);
    }

    let limit = {};
    limit.value = (limitString == "low") ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    for (let i = 0; i < observedCondition.length; i++)
    {
        if (limitString == "low")
        {
            if (observedCondition[i].value < limit.value)
            {
                limit.value = observedCondition[i].value;
                limit.dt = observedCondition[i].dt;
            }
        }
        else if (limitString == "high")
        {
            if (observedCondition[i].value > limit.value)
            {
                limit.value = observedCondition[i].value;
                limit.dt = observedCondition[i].dt;
            }
        }
    }

    let valueString;
    switch (conditionString)
    {
        case "snow":
            valueString = `rate of snowfall will be ${limit.value}mm per 3 hours`;
            break;
        case "rain":
            valueString = `rate of rainfall will be ${limit.value}mm per 3 hours`;
            break;
        case "pressure":
            valueString = `pressure will be ${Number(limit.value*.02953).toFixed(2)} inMg`;
            break;
        case "visibility":
            if (limit.value >= 10000) valueString = `visibility will be more than 10km`;
            else valueString = `visibility will be ${limit.value}m`;
            break;
        case "cloud cover":
            valueString = `cloud cover will be ${limit.value}%`;
            break;
        case "wind":
            valueString = `wind speed will be ${Number(limit.value * 2.237).toFixed(1)} mph`;
            break;
        case "temperature":
            valueString = `temperature will be ${kToF(limit.value)} degrees`;
            break;
        case "pop":
            valueString = `chance of precipitation will be ${limit.value*100}%`;
            break;
    }
    let outputString = `In ${locationString} at ${readableDateTime(limit.dt, tz)}, the ${limitString}est ${valueString}.`;
    return outputString;
}

//API call(s) based on user input
async function grabData(location, current, count)
{
    //obtain the type of API call to make
    let selectionString = (current) ? "weather" : "forecast";

    //get how far in the future to get the forecast for
    let countString = (count === undefined || count > 5 || count < 1) ? "" : `&cnt=${count*8}`;

    //used as the direct string for the api input
    let locationString;

    //initally get the location information
    let obtainedLocation = {};
    obtainedLocation.cityName = location.city;
    obtainedLocation.stateName = location["admin-area"];
    obtainedLocation.stateCode = getStateCodeFromName(location["admin-area"]);
    obtainedLocation.countryName = location.country;
    obtainedLocation.countryCode = "";

    //if a zip code is defined, use that and that is all the info that is needed
    if (isFieldDefined(location['zip-code']))
    {
        let zipLocationCall = `http://api.openweathermap.org/geo/1.0/zip?zip=${location['zip-code']}&appid=${key}`;
        console.log(`\tCalling ${zipLocationCall}`);
        let zipLocationResponse = await axios.get(zipLocationCall);
        obtainedLocation.cityName = zipLocationResponse.data.name;
        obtainedLocation.countryCode = zipLocationResponse.data.country;
        locationString = `zip=${location['zip-code']}`;
    }
    //otherwise, get all of the information possible from the user input in case things are ambiguous
    else
    {
        //attempt to get a country code from the user-specified country location
        if (isFieldDefined(location.country))
        {
            try
            {
                let countryResponse = await axios.get(`https://restcountries.com/v3.1/name/${location.country}`);
                for (let i = 0; i < countryResponse.data.length; i++)
                {
                    //go through the responses and get the country code of the country that matches the name
                    if (location.country == countryResponse.data[i].name.common)
                    {
                        obtainedLocation.countryCode = `${countryResponse.data[i].cca2}`;
                    }
                }
            }
            catch (error)
            {
                console.log(`Error finding country from user query: ${location.country}. Nothing will be done about this.`);
            }
        }

        //use geocoding api to obtain the correct location information for ambiguous location names
        try
        {
            //string used for the api call. get as specific as the user allowed
            let apiLocString = (isFieldDefined(location.country)) ? `${location.city},${obtainedLocation.countryCode}` : location.city;
            let initialLoctionCall = `http://api.openweathermap.org/geo/1.0/direct?q=${apiLocString}&limit=10&appid=${key}`;
            console.log(`\tCalling ${initialLoctionCall}`);
            let locationResponse = await axios.get(initialLoctionCall);
            
            let matchFound = false;
            for (let i = 0; i < locationResponse.data.length; i++)
            {
                
                if (isFieldDefined(location["admin-area"])) //check if the user-inputted object has a state/providence
                {
                    if (location["admin-area"] == locationResponse.data[i].state)
                    {
                        obtainedLocation.cityName = locationResponse.data[i].name;
                        obtainedLocation.stateName = locationResponse.data[i].state;
                        obtainedLocation.countryCode = locationResponse.data[i].country;
                        matchFound = true;
                        break;
                    }
                }
            }
            if (!matchFound && locationResponse.data.length > 0)
            {
                obtainedLocation.cityName = locationResponse.data[0].name;
                obtainedLocation.stateName = locationResponse.data[0].state;
                obtainedLocation.countryCode = locationResponse.data[0].country;
            }
        }
        catch (error)
        {
            return undefined;
        }

        let stateString = (obtainedLocation.stateCode) ? `,${obtainedLocation.stateCode}` : "";
        locationString = `q=${obtainedLocation.cityName}${stateString},${obtainedLocation.countryCode}`;
    }
    
    try
    {
        let weatherCall = `http://api.openweathermap.org/data/2.5/${selectionString}?${locationString}${countString}&APPID=${key}`;
        console.log(`\tCalling ${weatherCall}`);
        let weatherResponse = await axios.get(weatherCall);

        weatherResponse.data.location = obtainedLocation; //inject an object that has location info
        return weatherResponse.data;
    }
    catch (error)
    {
        //console.error(error);
        return undefined;
    }
}

/*
 *
 *  Helper Functions
 *
*/
function getDirectionFromDegree(degree)
{
    if (isBetween(degree, 348.75, 360) || isBetween(degree, 0, 11.25)) return "north";
    else if (isBetween(degree, 11.25, 33.75)) return "north-northeast";
    else if (isBetween(degree, 33.75, 56.25)) return "northeast";
    else if (isBetween(degree, 56.25, 78.75)) return "east-northeast";
    else if (isBetween(degree, 78.75, 101.25)) return "east";
    else if (isBetween(degree, 101.25, 123.75)) return "east-southeast";
    else if (isBetween(degree, 123.75, 146.25)) return "southeast";
    else if (isBetween(degree, 146.25, 168.75)) return "south-southeast";
    else if (isBetween(degree, 168.75, 191.25)) return "south";
    else if (isBetween(degree, 191.25, 213.75)) return "south-southwest";
    else if (isBetween(degree, 213.75, 236.25)) return "southwest";
    else if (isBetween(degree, 236.25, 258.75)) return "west-southwest";
    else if (isBetween(degree, 258.75, 281.25)) return "west";
    else if (isBetween(degree, 281.25, 303.75)) return "west-northwest";
    else if (isBetween(degree, 303.75, 326.25)) return "northwest";
    else if (isBetween(degree, 326.25, 348.75)) return "north-northwest";
    else return "unknown";
}

function isBetween(value, min, max)
{
    return value >= min && value <= max;
}

function kToF(value)
{
    return Number(((value-273.15)*(9/5)+32).toFixed(1));
}

function readableDateTime(utcDate, tzOffset)
{
    //artificially make a UTC date that is offset by the location's timezone to output a string with the 'correct' local time.
    //a lot easier than converting a timezone offset to a timezone string like "America/Los_Angeles"
    let date = new Date(utcDate.getTime()+(tzOffset*1000));

    //returns string in local time, wherever that is
    return `${date.toLocaleTimeString('en-US', { hour: 'numeric', minute:'2-digit', timeZone: 'UTC' })} on ${weekday[date.getDay()]}`;
}

//"On Thursday at 3:30pm, there will be __________."
//IDs are per https://openweathermap.org/weather-conditions
function idToPhrase(id)
{
    if (isBetween(id, 200, 209)) return "thunderstorms with rain";
    else if (isBetween(id, 210, 219)) return "thunderstorms";
    else if (isBetween(id, 220, 229)) return "ragged thunderstorms";
    else if (isBetween(id, 230, 239)) return "thunderstorms with drizzle";
    else if (isBetween(id, 300, 309)) return "drizzles";
    else if (isBetween(id, 310, 319)) return "drizzling rain";
    else if (isBetween(id, 320, 329)) return "shower drizzles";
    else if (isBetween(id, 500, 501)) return "rain";
    else if (isBetween(id, 502, 504)) return "heavy rain";
    else if (id == 511) return "freezing rain";
    else if (isBetween(id, 520, 521)) return "rain showers";
    else if (isBetween(id, 522, 529)) return "heavy rain showers";
    else if (isBetween(id, 531, 539)) return "ragged rain showers";
    else if (isBetween(id, 600, 601)) return "snow";
    else if (isBetween(id, 602, 609)) return "heavy snow";
    else if (id == 611) return "sleet";
    else if (isBetween(id, 612, 619)) return "rain and snow mix";
    else if (isBetween(id, 620, 621)) return "show showers";
    else if (isBetween(id, 622, 629)) return "heavy show showers";
    else if (id == 701) return "mist";
    else if (id == 711) return "smoke";
    else if (id == 721) return "haze";
    else if (id == 731) return "sand or dust whirls";
    else if (id == 741) return "fog";
    else if (id == 751) return "sandstorms";
    else if (id == 761) return "dust storms";
    else if (id == 762) return "volcanic ash";
    else if (id == 771) return "squalls";
    else if (id == 781) return "a possibility of tornados";
    else if (id == 800) return "clear skies";
    else if (isBetween(id, 801, 803)) return "scattered clouds";
    else if (isBetween(id, 804, 809)) return "overcast clouds";
    else return "an unknown weather condition";
}

function isFieldDefined(field)
{
    return (field !== undefined && field != "");
}

function getStateCodeFromName(state)
{
    switch (state.toUpperCase())
    {
        //canada
        case "NEWFOUNDLAND AND LABRADOR": return "NL";
        case "ALBERTA": return "AB";
        case "SASKATCHEWAN": return "SK";
        case "PRINCE EDWARD ISLAND": return "PE";
        case "BRITISH COLUMBIA": return "BC";
        case "MANITOBA": return "MB";
        case "NEW BRUNSWICK": return "NB";
        case "NOVA SCOTIA": return "NS";
        case "QUEBEC": return "QC";
        case "ONTARIO": return "ON";

        //US and territories
        case "ALABAMA": return "AL";
        case "ALASKA": return "AK";
        case "AMERICAN SAMOA": return "AS";
        case "ARIZONA": return "AZ";
        case "ARKANSAS": return "AR";
        case "CALIFORNIA": return "CA";
        case "COLORADO": return "CO";
        case "CONNECTICUT": return "CT";
        case "DELAWARE": return "DE";
        case "DISTRICT OF COLUMBIA": return "DC";
        case "FEDERATED STATES OF MICRONESIA": return "FM";
        case "FLORIDA": return "FL";
        case "GEORGIA": return "GA";
        case "GUAM": return "GU";
        case "HAWAII": return "HI";
        case "IDAHO": return "ID";
        case "ILLINOIS": return "IL";
        case "INDIANA": return "IN";
        case "IOWA": return "IA";
        case "KANSAS": return "KS";
        case "KENTUCKY": return "KY";
        case "LOUISIANA": return "LA";
        case "MAINE": return "ME";
        case "MARSHALL ISLANDS": return "MH";
        case "MARYLAND": return "MD";
        case "MASSACHUSETTS": return "MA";
        case "MICHIGAN": return "MI";
        case "MINNESOTA": return "MN";
        case "MISSISSIPPI": return "MS";
        case "MISSOURI": return "MO";
        case "MONTANA": return "MT";
        case "NEBRASKA": return "NE";
        case "NEVADA": return "NV";
        case "NEW HAMPSHIRE": return "NH";
        case "NEW JERSEY": return "NJ";
        case "NEW MEXICO": return "NM";
        case "NEW YORK": return "NY";
        case "NORTH CAROLINA": return "NC";
        case "NORTH DAKOTA": return "ND";
        case "NORTHERN MARIANA ISLANDS": return "MP";
        case "OHIO": return "OH";
        case "OKLAHOMA": return "OK";
        case "OREGON": return "OR";
        case "PALAU": return "PW";
        case "PENNSYLVANIA": return "PA";
        case "PUERTO RICO": return "PR";
        case "RHODE ISLAND": return "RI";
        case "SOUTH CAROLINA": return "SC";
        case "SOUTH DAKOTA": return "SD";
        case "TENNESSEE": return "TN";
        case "TEXAS": return "TX";
        case "UTAH": return "UT";
        case "VERMONT": return "VT";
        case "VIRGIN ISLANDS": return "VI";
        case "VIRGINIA": return "VA";
        case "WASHINGTON": return "WA";
        case "WEST VIRGINIA": return "WV";
        case "WISCONSIN": return "WI";
        case "WYOMING": return "WY";
        default: return "";
    }
}

function getLocationStringFromObject(location)
{
    let state;
    if (isFieldDefined(location.stateCode)) state = location.stateCode;
    if (isFieldDefined(location.stateName)) state = location.stateName;
    if (isFieldDefined(state)) state = `, ${state}`;
    else state = "";

    let country;
    if (isFieldDefined(location.countryCode)) country = location.countryCode;
    if (isFieldDefined(location.countryName)) country = location.countryName;
    if (isFieldDefined(country)) country = `, ${country}`;
    else country = "";

    let region;
    if (isFieldDefined(state)) region = state;
    else region = country;
    let loc = `${location.cityName}${region}`;
    return loc;
}