# Threads Downloader

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

[Open the Threads Downloader live service](https://threads.pylot.dev/)

Threads Downloader is an independent tool for downloading videos from public Threads posts that
any visitor can view without signing in. It is not an official Threads service and is not endorsed
by Threads, Meta, or Instagram.

## How to use it

1. Open the [live service](https://threads.pylot.dev/).
2. Paste the URL of a public Threads post.
3. Confirm that you own the content, have permission, or may make the intended use under applicable
   law.
4. Select **Get video**. The security check usually runs automatically, but follow any on-screen
   prompt if additional action is required.
5. Choose the video version you need and download it.

## Supported content

- Only public Threads posts that an ordinary visitor can view without signing in are supported.
- Private, sign-in-only, age-restricted, region-restricted, and otherwise restricted content is not
  processed, and access restrictions are not bypassed.
- Threads page formats and platform restrictions can change, so not every public post is guaranteed
  to resolve successfully.
- Download only content that you have the right to use. Public visibility does not grant permission
  for unrestricted use.

The complete Terms of Use, Privacy and Data Processing Notice, and Copyright and Takedown Notice are
available from the site's header or footer and open in a dialog. For copyright, takedown, or privacy
questions, email [pony@pylot.dev](mailto:pony@pylot.dev).

## Troubleshooting

- **Complete the security check first.** Wait a few seconds and try again, and make sure the
  browser is not blocking scripts required by the site.
- **The post cannot be resolved.** Confirm that the URL points to a public post that does not require
  sign-in. If it still fails later, the post may be outside the supported scope.
- **The video cannot be downloaded.** Resolve the post again and choose a version; download links
  expire after a limited time.
- **The problem continues.** Report it in the
  [project repository](https://github.com/Willseed/ThreadsDownloader) and include the on-screen error
  message. Do not post private content or account information in a public issue.

## Official links

- [Threads Downloader live service](https://threads.pylot.dev/)
- [Threads website](https://www.threads.com/)
- [Threads Downloader project repository](https://github.com/Willseed/ThreadsDownloader)

## Maintainer resources

The following maintainer documentation is currently written in Traditional Chinese:

- [Design and user-experience principles](DESIGN.md)
- [Operations and deployment handbook](docs/operations.md)
- [Research notes](docs/research/)
