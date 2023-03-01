# Introduction

The famly app (https://app.famly.co/) does not currently allow parents to download all media shared of their child without manually going to each individual feed item and saving them.

This tool plugs that gap. It does _not_ enable downloading of anything you don't have access to in the app or the website.

It will download all images, videos, and files shared in the feed. Images sent via private messages are not currently downloaded.

The creator of this tool is not affiliated with famly in any way.

# Features

- Download all images, videos, and files shared on your feed
- Set Exif dates on images and videos
- Store state for the most recent downloaded feed items and only download new feed items on future runs
- Image and video file names prefixed with dates for easy sorting

# Usage

## Quick start

1. Download and install Node.js 18.0.0 or above (https://nodejs.org/en/)
2. Download this repository
3. Run `npm install`
4. Run `node app.js -d -u <username> -p <password>`

This will download the entire feed to the `downloads/`folder on the first run. It will create a file called `.famlydownloaderdelta` where it stores the most recent feed item it has downloaded, and subsequent runs will only download feed items newer than this.

Credentials can also be passed via environment variables (including via `.env` file).

## Command Line Parameters

A full list of command line params can be found by running with the `--help` flag:

    node app.js --help
    Usage: app [options]

    Options:
    -u, --username <string>          Please specify username (env: FAMLY_USERNAME)
    -p, --password <string>          Please specify password (env: FAMLY_PASSWORD)
    -df, --download-folder <string>  Please specify download folder (default: "downloads/", env: FAMLY_DOWNLOAD_FOLDER)
    --graphqlurl <string>            Please specify download folder (default: "https://app.famly.co/graphql", env: FAMLY_GRAPHQL_URL)
    -ds, --download-since <date>     Download all media posted after this date. Must be in a format accepted by the new Date() constructor. Takes priority over the
                                    --delta parameter (env: FAMLY_DOWNLOAD_SINCE)
    -d, --delta                      Downloads all media posted after the date in the .delta file. (env: FAMLY_DELTA)
    --disable-exif                   Disables setting the exif dates of photos. (env: FAMLY_DISABLE_EXIF)
    -v, --verbose                    Enables verbose logging (env: FAMLY_VERBOSE)
    -ht, --height-target <integer>   The height target to use when fetching feed items. Higher number = fewer requests. (default: 10000, env: FAMLY_HEIGHT_TARGET)
    -h, --help                       display help for command
