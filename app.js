import { createWriteStream } from "fs";
import { v4 } from "uuid";
import { program } from "commander";

import { pipeline } from "node:stream";
import { promisify } from "node:util";

program
  .requiredOption("-u, --username <string>")
  .requiredOption("-p, --password <string>")
  .option(
    "-df, --downloadfolder <string>",
    "Relative download folder.  Defaults to downloads/",
    "downloads/"
  )
  .option(
    "--graphqlurl <string>",
    "The URL for GraphQL.  Defaults to https://app.famly.co/graphql",
    "https://app.famly.co/graphql"
  );

program.parse();

const options = program.opts();
//const limit = options.first ? 1 : undefined;
const username = options.username;
const password = options.password;
const downloadFolder = options.downloadfolder;
const graphqlURL = options.graphqlurl;
console.log(username);
console.log(password);
console.log(downloadFolder);
console.log(graphqlURL);

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
  // Get the feed. This will download the feed media and also return all observationIds
  const observationIds = await getFeed(accessToken);
  // Download the media from observations
  await getObservations(accessToken, observationIds);
}

async function getObservations(accessToken, observationIds) {
  // This is the graphql query to fetch all observations.
  // FIXME: Don't fetch all in one go. Split it up in chunks
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
    createdAt = el.status.createdAt;
    el.images.forEach((image) => {
      const { height, width } = image;
      const { expires, key, path, prefix } = image.secret;

      const url = `${prefix}/${key}/${width}x${height}/${path}?expires=${expires}`;

      const fileName = path.substring(path.lastIndexOf("/") + 1);

      downloadFile(url, createdAt + "_" + fileName);
    });
    if (el.video != null) {
      const url = el.video.videoUrl;
      const removePathParam = url.split("?")[0];
      const fileName = removePathParam.substring(
        removePathParam.lastIndexOf("/") + 1
      );

      downloadFile(url, createdAt + "_" + fileName);
    }
  });
}

async function getFeed(accessToken) {
  const observationIds = [];
  // The feed API is interesting in that it has two params: olderThan and heightTarget
  // It appears to fetch the number of items that it think will fit within that heightTarget
  // And only those older than olderThan.
  // In this case we fetch the entire feed as our heightTarget is massive and olderThan is in the future
  // FIXME: Don't fetch a massive payload in one go, split this up in sensible chunks
  const feedURL =
    "https://app.famly.co/api/feed/feed/feed?olderThan=2099-10-27T13%3A18%3A02%2B00%3A00&heightTarget=18600000000";
  const res = await fetch(feedURL, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-famly-accesstoken": accessToken,
      "x-famly-installationid": installationId,
    },
  });

  const json = await res.json();
  console.log(json.feedItems.length);
  json.feedItems.forEach((feedItem) => {
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
          downloadFile(url, createdDate + "_" + fileName);
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

          downloadFile(url, createdAt + "_" + imageId + suffix);
        });
      }
    }
  });
  return observationIds;
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
}
