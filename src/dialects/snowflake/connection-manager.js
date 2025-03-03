'use strict';

const { AbstractConnectionManager } = require('../abstract/connection-manager');
const SequelizeErrors = require('../../errors');
const { logger } = require('../../utils/logger');
const DataTypes = require('../../data-types').snowflake;

const debug = logger.debugContext('connection:snowflake');
const parserStore = require('../parserStore')('snowflake');

/**
 * Snowflake Connection Manager
 *
 * Get connections, validate and disconnect them.
 *
 * @private
 */
export class SnowflakeConnectionManager extends AbstractConnectionManager {
  constructor(dialect, sequelize) {
    super(dialect, sequelize);
    this.lib = this._loadDialectModule('snowflake-sdk');
    this.refreshTypeParser(DataTypes);
  }

  _refreshTypeParser(dataType) {
    parserStore.refresh(dataType);
  }

  _clearTypeParser() {
    parserStore.clear();
  }

  static _typecast(field, next) {
    if (parserStore.get(field.type)) {
      return parserStore.get(field.type)(field, this.sequelize.options, next);
    }

    return next();
  }

  /**
   * Connect with a snowflake database based on config, Handle any errors in connection
   * Set the pool handlers on connection.error
   * Also set proper timezone once connection is connected.
   *
   * @param {object} config
   * @returns {Promise<Connection>}
   * @private
   */
  async connect(config) {
    const connectionConfig = {
      account: config.host,
      username: config.username,
      password: config.password,
      database: config.database,
      warehouse: config.warehouse,
      role: config.role,
      /*
      flags: '-FOUND_ROWS',
      timezone: this.sequelize.options.timezone,
      typeCast: SnowflakeConnectionManager._typecast.bind(this),
      bigNumberStrings: false,
      supportBigNumbers: true,
      */
      ...config.dialectOptions,
    };

    try {

      const connection = await new Promise((resolve, reject) => {
        this.lib.createConnection(connectionConfig).connect((err, conn) => {
          if (err) {
            console.error(err);
            reject(err);
          } else {
            resolve(conn);
          }
        });
      });

      debug('connection acquired');

      if (!this.sequelize.config.keepDefaultTimezone) {
        // default value is '+00:00', put a quick workaround for it.
        const tzOffset = this.sequelize.options.timezone === '+00:00' ? 'Etc/UTC' : this.sequelize.options.timezone;
        const isNamedTzOffset = /\//.test(tzOffset);
        if (isNamedTzOffset) {
          await new Promise((resolve, reject) => {
            connection.execute({
              sqlText: `ALTER SESSION SET timezone = '${tzOffset}'`,
              complete(err) {
                if (err) {
                  console.error(err);
                  reject(err);
                } else {
                  resolve();
                }
              },
            });
          });
        } else {
          throw new Error('only support time zone name for snowflake!');
        }
      }

      return connection;
    } catch (error) {
      switch (error.code) {
        case 'ECONNREFUSED':
          throw new SequelizeErrors.ConnectionRefusedError(error);
        case 'ER_ACCESS_DENIED_ERROR':
          throw new SequelizeErrors.AccessDeniedError(error);
        case 'ENOTFOUND':
          throw new SequelizeErrors.HostNotFoundError(error);
        case 'EHOSTUNREACH':
          throw new SequelizeErrors.HostNotReachableError(error);
        case 'EINVAL':
          throw new SequelizeErrors.InvalidConnectionError(error);
        default:
          throw new SequelizeErrors.ConnectionError(error);
      }
    }
  }

  async disconnect(connection) {
    // Don't disconnect connections with CLOSED state
    if (!connection.isUp()) {
      debug('connection tried to disconnect but was already at CLOSED state');

      return;
    }

    return new Promise((resolve, reject) => {
      connection.destroy(err => {
        if (err) {
          console.error(`Unable to disconnect: ${err.message}`);
          reject(err);
        } else {
          console.error(`Disconnected connection with id: ${connection.getId()}`);
          resolve(connection.getId());
        }
      });
    });
  }

  validate(connection) {
    return connection.isUp();
  }
}
