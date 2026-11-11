# Coordinator team and enterprise features

This folder holds the parts of the Coordinator service that teams pay for. It is empty today. Everything else in `service/` is AGPL-3.0 and stays free to build, host and deploy.

## What belongs here

Features a single developer does not need and a team does:

- single sign-on;
- seats and roles;
- dashboards across an organisation's repositories;
- audit export.

Features that make one person's runs work, or keep them safe, never move here.

## Licence

Code in this folder is under the [enterprise licence](LICENSE.md), not AGPL. In short:

- you may read it, change it and run it for development and testing at no cost;
- running it in production needs a subscription;
- the core service must keep working without this folder.

Prices are not set yet. Teams that start early will get a free period first. To ask about a subscription or a trial, open the [sponsor or partner form](https://github.com/mindmakr/coordinator/issues/new?template=sponsor-or-partner.yml).
