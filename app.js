import * as dotenv from "dotenv";
dotenv.config();
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { v4 } from "uuid";
import { program, Option } from "commander";

import { pipeline } from "node:stream";
import { promisify } from "node:util";

import { exiftool } from "exiftool-vendored";

program.addOption(
  new Option("-u, --username <string>", "Please specify username")
    .env("FAMLY_USERNAME")
    .makeOptionMandatory()
);
program.addOption(
  new Option("-p, --password <string>", "Please specify password")
    .env("FAMLY_PASSWORD")
    .makeOptionMandatory()
);
program.addOption(
  new Option(
    "-df, --download-folder <string>",
    "Please specify download folder"
  )
    .env("FAMLY_DOWNLOAD_FOLDER")
    .default("downloads/")
);
program.addOption(
  new Option("--graphqlurl <string>", "Please specify download folder")
    .env("FAMLY_GRAPHQL_URL")
    .default("https://app.famly.co/graphql")
);
program.addOption(
  new Option(
    "-ds, --download-since <date>",
    "Download all media posted after this date. Must be in a format accepted by the new Date() constructor. Takes priority over the --delta parameter"
  ).env("FAMLY_DOWNLOAD_SINCE")
);

program.addOption(
  new Option(
    "-d, --delta",
    "Downloads all media posted after the date in the .delta file."
  ).env("FAMLY_DELTA")
);

program.addOption(
  new Option(
    "--disable-exif",
    "Disables setting the exif dates of photos."
  ).env("FAMLY_DISABLE_EXIF")
);

program.addOption(
  new Option("-v, --verbose", "Enables verbose logging").env("FAMLY_VERBOSE")
);

program.addOption(
  new Option(
    "-ht, --height-target <integer>",
    "The height target to use when fetching feed items. Higher number = fewer requests."
  )
    .default(10000)
    .env("FAMLY_HEIGHT_TARGET")
);

program.parse();

const options = program.opts();

const famlyDeltaFilename = ".famlydownloaderdelta";
const username = options.username;

const password = options.password;
const downloadFolder = options.downloadFolder;
const graphqlURL = options.graphqlurl;

const getDeltaDownloadDate = () => {
  try {
    return JSON.parse(readFileSync(famlyDeltaFilename, "utf8")).newestDownload;
  } catch (err) {
    return undefined;
  }
};

// If downloadSince is set, use that date
// Otherwise, if delta is set, use that date
// If not, download everything again
const downloadMediaSince = new Date(
  options.downloadSince ||
    (options.delta === undefined ? undefined : getDeltaDownloadDate())
);

if (isNaN(downloadMediaSince)) {
  console.log(`Download all feed items.`);
} else {
  console.log(`Download all feed items created after: ${downloadMediaSince}`);
}

const disableExif = options.downloadSince;
const verbose = options.verbose;
const heightTarget = options.heightTarget;

if (verbose) {
  console.log(`Settings: ${options}`);
}

try {
  if (!existsSync(downloadFolder)) {
    mkdirSync(downloadFolder);
  }
} catch (err) {
  console.error(`Could not create download folder: ${err}`);
}

const installationId = v4();

getData(username, password);

/**
 * There are two types of media to download:
 *  - Media posted as normal feed items
 *  - Media posted in observations
 * Feed items are easy as they are just part of the feed elements
 * Observations are slightly more painful as we have to:
 *  1. Get the observationId from the feed
 *  2. Query graphql for the media URLs using the observationIds
 *
 */
async function getData(username, password) {
  // First log in and get an access token
  const accessToken = await login(username, password);
  if (verbose) {
    console.log(`Access Token : ${accessToken}`);
  }
  // Get the feed. This will download the feed media and observation data
  await getFeed(accessToken);
}

async function getObservations(accessToken, observationIds) {
  if (verbose) {
    console.log(`Downloading Observations IDs: ${observationIds}`);
  }
  // This is the graphql query to fetch all observations.
  const query = `
    "query ObservationsByIds($observationIds: [ObservationId!]!) {  childDevelopment {    observations(      first: 2147483647 observationIds: $observationIds      ignoreMissing: true    ) {      results {        ...ObservationData        __typename      }      __typename    }    __typename  }}fragment ObservationData on Observation {  ...ObservationDataWithNoComments  __typename}fragment ObservationDataWithNoComments on Observation {  children {    id    name    institutionId    __typename  }  id  version  feedItem {    id    __typename  }  status {    state    createdAt    __typename  }  variant  images {    height    width    id    secret {      crop      expires      key      path      prefix      __typename    }    __typename  }  video {    ... on TranscodingVideo {      id      __typename    }    ... on TranscodedVideo {      duration      height      id      thumbnailUrl      videoUrl      width      __typename    }    __typename  }  __typename}"`;

  const payload = `
{
    "operationName": "ObservationsByIds",
    "variables": {
        "observationIds": 
            ${JSON.stringify(observationIds)}
        
    },
    "query": ${query}
}`;
  const res = await fetch(graphqlURL, {
    method: "POST",
    body: payload,
    headers: {
      "Content-Type": "application/json",
      "x-famly-accesstoken": accessToken,
      "x-famly-installationid": installationId,
    },
  });
  const json = await res.json();

  json.data.childDevelopment.observations.results.forEach((el) => {
    // Loop over the observations
    const createdAt = el.status.createdAt;
    el.images.forEach((image) => {
      const { height, width } = image;
      const { expires, key, path, prefix } = image.secret;

      const url = `${prefix}/${key}/${width}x${height}/${path}?expires=${expires}`;

      const fileName = path.substring(path.lastIndexOf("/") + 1);
      const fullFileName = createdAt + "_" + fileName;

      downloadFile(url, fullFileName).then((path) => {
        setExifData(path, new Date(createdAt));
      });
    });
    if (el.video != null) {
      const url = el.video.videoUrl;
      const removePathParam = url.split("?")[0];
      const fileName = removePathParam.substring(
        removePathParam.lastIndexOf("/") + 1
      );
      const fullFileName = createdAt + "_" + fileName;

      downloadFile(url, fullFileName).then((path) => {
        setExifData(path, new Date(createdAt));
      });
    }
  });
}

async function getFeed(accessToken) {
  let date = new Date();
  let numItemsFromFeed = 1;
  let newestDate = NaN;

  while (numItemsFromFeed > 0) {
    const { observationIds, oldestItem, newestItem, numItems } =
      await getFeedItems(accessToken, date, newestDate);

    numItemsFromFeed = numItems;

    // Download the media from observations
    if (observationIds.length > 0) {
      await getObservations(accessToken, observationIds);
    }

    date = oldestItem;
    newestDate = newestItem;
  }

  if (!isNaN(date)) {
    writeFileSync(
      famlyDeltaFilename,
      JSON.stringify({ newestDownload: newestDate })
    );
  }
  console.log(
    `Downloads finished. Oldest feed item downloaded = ${date}. Application will close once setting EXIF data is complete. This can take a long time.`
  );
}

async function getFeedItems(accessToken, olderThan, newestItem) {
  let oldestItem = olderThan;

  const dateStr = olderThan.toISOString().split(".")[0] + "+00:00";
  const encodedDateStr = encodeURIComponent(dateStr);

  const observationIds = [];

  const feedURL = `https://app.famly.co/api/feed/feed/feed?olderThan=${encodedDateStr}&heightTarget=${heightTarget}`;
  console.log(`Downloading feed items older than ${dateStr}. URL = ${feedURL}`);
  const res = await fetch(feedURL, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-famly-accesstoken": accessToken,
      "x-famly-installationid": installationId,
    },
  });

  const json = await res.json();
  //const numItems = json.feedItems.length;
  let numItems = 0;
  json.feedItems.forEach((feedItem) => {
    const feedItemDate = new Date(feedItem.createdDate);
    if (!isNaN(downloadMediaSince) && feedItemDate <= downloadMediaSince) {
      return;
    }
    numItems++;

    if (feedItemDate < oldestItem) {
      oldestItem = feedItemDate;
    }
    if (isNaN(newestItem) || feedItemDate > newestItem) {
      newestItem = feedItemDate;
    }
    if (feedItem.embed != null && feedItem.embed.observationId != null) {
      // If the feedItem is an observation, just store the observationId
      // We will need it later when we query for the observation data
      observationIds.push(feedItem.embed.observationId);
    } else {
      // If it's a feed item,
      // check if it has a video and if so download it
      // then check if it has images and download them
      if (feedItem.videos != null) {
        const createdDate = feedItem.createdDate;
        feedItem.videos.forEach((video) => {
          const url = video.videoUrl;
          const removePathParam = url.split("?")[0];
          const fileName = removePathParam.substring(
            removePathParam.lastIndexOf("/") + 1
          );
          const fullFileName = createdDate + "_" + fileName;
          downloadFile(url, fullFileName).then((path) => {
            setExifData(path, new Date(createdDate));
          });
        });
      }

      if (feedItem.images != null) {
        // has at least one image
        feedItem.images.forEach((image) => {
          const imageId = image.imageId;
          const prefix = image.prefix;
          const height = image.height;
          const width = image.width;
          const key = image.key;
          const createdAt = image.createdAt.date.replace(" ", "_");

          // FIXME: Get the suffix from the data instead
          let suffix = ".png";

          if (key.includes(".jpg")) {
            suffix = ".jpg";
          } else if (key.includes(".png")) {
            suffix = ".png";
          } else {
            console.log(
              `Key doesn't contain .jpg or .png. Which file format? ${key}`
            );
          }

          const url = `${prefix}/${width}x${height}/${key}`;
          const fileName = createdAt + "_" + imageId + suffix;

          downloadFile(url, fileName).then((path) => {
            setExifData(path, new Date(image.createdAt.date));
          });
        });
      }

      if (feedItem.files != null) {
        feedItem.files.forEach((file) => {
          // Set the filename to original filename (minus file extension) + date + file extension.
          // For example: Document.pdf
          // Becomes: Document-2023-02-01.pdf
          const fileName = file.filename;
          const fileNameSplit = fileName.split(".");
          const extension = fileNameSplit[fileNameSplit.length - 1];
          const fullFileName = `${fileName.substring(
            0,
            fileName.length - (extension.length + 1)
          )}_${feedItem.createdDate}.${extension}`;

          const url = file.url;

          downloadFile(url, fullFileName);
        });
      }
    }
  });
  return { observationIds, oldestItem, newestItem, numItems };
}

/**
 * Login to fetch an accessToken
 * @param {string} username
 * @param {string} password
 * @returns {string} an accessToken
 */
async function login(username, password) {
  const loginRequest = `
{
    "operationName":"Authenticate",
    "variables":{
       "email":"${username}",
       "password":"${password}",
       "deviceId":null,
       "legacy":true
    },
    "query":"mutation Authenticate($email: EmailAddress!, $password: Password!, $deviceId: DeviceId, $legacy: Boolean) {  me {    authenticateWithPassword(email: $email, password: $password, deviceId: $deviceId, legacy: $legacy) {      ...AuthenticationResult      __typename    }    __typename  }}fragment AuthenticationResult on AuthenticationResult {  status  __typename  ... on AuthenticationFailed {    status    errorDetails    errorTitle    __typename  }  ... on AuthenticationSucceeded {    accessToken    deviceId    __typename  }  ... on AuthenticationChallenged {    ...AuthChallenge    __typename  }}fragment AuthChallenge on AuthenticationChallenged {  loginId  deviceId  expiresAt  choices {    context {      ...UserContextFragment      __typename    }    hmac    requiresTwoFactor    __typename  }  person {    name {      fullName      __typename    }    profileImage {      url      __typename    }    __typename  }  __typename}fragment UserContextFragment on UserContext {  id  target {    __typename    ... on PersonContextTarget {      person {        name {          fullName          __typename        }        __typename      }      children {        name {          firstName          fullName          __typename        }        profileImage {          url          __typename        }        __typename      }      __typename    }    ... on InstitutionSet {      title      profileImage {        url        __typename      }      __typename    }  }  __typename}"
 }
`;

  const res = await fetch(graphqlURL, {
    method: "POST",
    body: loginRequest,
    headers: { "Content-Type": "application/json" },
  });

  const json = await res.json();
  const accessToken = json.data.me.authenticateWithPassword.accessToken;
  console.log(accessToken);
  return accessToken;
}

/**
 * Download a file to disk. Stores it in downloadFolder
 * @param {String} url the URL to download
 * @param {String} name the filename to use
 */
async function downloadFile(url, name) {
  const path = downloadFolder + name;
  const streamPipeline = promisify(pipeline);

  const res = await fetch(url, {
    method: "GET",
  });
  const writeStream = await streamPipeline(res.body, createWriteStream(path));
  return path;
}

let numExifSet = 0;
/**
 * Set dates to EXIF data on files
 * @param {String} path the path of the file to set EXIF data on
 * @param {Date} date The date to set
 */
async function setExifData(path, date) {
  if (disableExif) return;
  await exiftool.write(path, { AllDates: date.toISOString().split(".")[0] }, [
    "-overwrite_original",
  ]);
  numExifSet++;
  if (numExifSet % 100 === 0) {
    console.log(`EXIF Progress. ${numExifSet} files complete`);
  }
  if (verbose) {
    console.log(`Exif for file completed: ${path}`);
  }
}
