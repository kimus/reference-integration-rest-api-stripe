require('dotenv').config();

// Imports
const express = require('express');
const axios = require('axios');
const ngrok = require('ngrok');

let configPath = {url: '', port: 3009};

// Express server configuration
const app = express();
app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Switch credentials (available in Switch Dashboard)
const switchKeys = {
    accountId: process.env.SWITCH_ACCOUNT_ID,
    privateKey: process.env.SWITCH_PRIVATE_KEY,
    publicKey: process.env.SWITCH_PUBLIC_KEY
};

// Switch URL
const switchUrl = 'https://api-test.switchpayments.com/v2/';

/**
 * E-commerce page
 * Lets the client choose what he wants to purchase
 */
app.get('/', (req, res) => {
    // Get the product from the DB
    let product = DB.getProduct('sku42');

    res.send(`
        <html>
            <p>MERCHANT STORE</p>
            <form method="POST" action="/order">
                <legend> ${product.name} || Price: ${product.price} ${product.currency} </legend>
                <label>Quantity:</label>
                <input name="quantity" type="number" value="1">
                <input name="item" type="hidden" value="sku42">
                <input type="submit" value="Buy">
            </form>
        </html>
    `);
});

/**
 * Payment page with the Dynamic Forms
 * Creates an order and then instantiates the Dynamic Forms
 */
app.post('/order', (req, res) => {
    let itemId = req.body.item;
    let product = DB.getProduct(itemId);
    let quantity = req.body.quantity;
    let amount = quantity * product.price;

    // Creates an order
    let orderId = DB.createOrder({
        itemId: itemId,
        quantity: quantity,
        amount: amount,
        currency: product.currency,
        authorized: false // It hasn't authorized paid yet
    });

    // Body of the POST request
    let body = {
        charge_type: 'card_onetime',
        amount: amount,
        currency: product.currency,
        events_url: configPath.url + '/events',
        metadata: {'orderId': orderId},
        redirect_url: configPath.url + '/redirect'
    };

    // Configuration of the POST request
    let config = {
        auth: {
            username: switchKeys.accountId,
            password: switchKeys.privateKey
        }
    };

    let buff = Buffer.from(switchKeys.publicKey + ':');
    var auth = buff.toString('base64');

    // Makes a POST request to the Switch API to create a charge
    axios.post(switchUrl + 'charges', body, config)
        .then((response) => {
            console.log(response.data);
            return res.send(`
            <html>
                <p>PAYMENT</p>
                <button onclick="submitForm()">
                    PAY
                </button>
                <script>                  
                    let submitForm = () => {
                        // Makes a POST request to the Switch API to create an instrument
                        fetch('${switchUrl}' + 'instruments', {
                            method: 'POST',
                            headers: {
                                'Authorization': 'Basic ${auth}',
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                'charge': '${response.data.id}',
                                'name': 'John Doe',
                                'number': '4111111111111111',
                                'expiration_month': 12,
                                'expiration_year': 2030,
                                'cvc': '007'
                            })
                        })
                            .then((res) => {
                                if (res.ok) return res.json();
                                throw new Error(res.statusText);
                            })
                            .then((data) => {
                                document.write('redirecting...');
                                if (data && data.redirect && data.redirect.url){
                                    // Redirect to the URL
                                    window.location = data.redirect.url;
                                }
                                window.location = '/redirect?instrumentId=' + data.id;
                            })
                            .catch((error) => document.write(error.message + '. Please <a href="/">ty again</a>.'));
                    };
                </script>
            </html>
        `)})
        .catch((error) => res.send(error.response.data));
});

/**
 * Events webhooks
 * Waits for events and, when the event_type is 'instrument.authorized', marks the order as authorized and adds the instrumentId
 */
app.post('/events', (req, res) => {
    // Checks if the event_type is equal to 'instrument.authorized'
    if (req.query.event_type === 'instrument.authorized') {
        // Configuration of the GET request
        let config = {
            auth: {
                username: switchKeys.accountId,
                password: switchKeys.privateKey
            }
        };
        // Makes a GET request to the switch api to get the instrumentId from the orderId
        axios.get(switchUrl + 'events/' + req.query.event, config)
            .then((response) => {
                // Gets the order from the DB with the orderId
                let order = DB.getOrder(response.data.charge.metadata.orderId);

                // Add the instrumentId to the order
                order.instrumentId = response.data.instrument.id;

                // Marks the order as authorized
                order.authorized = true;
            })
            .catch((error) => res.send(error.response.data));
    }
    res.end();
});

/**
 * Redirect endpoint
 * Checks if the transaction was successful
 */
app.get('/redirect', (req, res) => {
    // Get request configuration
    let config = {
        auth: {
            username: switchKeys.accountId,
            password: switchKeys.privateKey
        }
    };
    // Makes a GET request to the switch api to check if the instrument is authorized
    axios.get(switchUrl + 'instruments/' + req.query.instrumentId, config)
        .then((response) => {
            // Checks if the instrument was authorized
            if (response.data.status === 'authorized') { // Transaction Success
                res.send(`
                    <html>
                        <p>Transaction Success</p>
                    </html>
                `);
            } else { // Transaction Error
                res.send(`
                    <html>
                        <p>Transaction Error</p>
                    </html>
                `);
            }
        })
        .catch((err) => res.send(err));
});

/**
 * Orders endpoint
 * Shows the orders
 */
app.get('/orders', (req, res) => {
    res.send(DB.orders);
});

// Create a network tunnel to allow Switch API to communicate with the local service
(async function (app, configPath) {
    configPath.url = await ngrok.connect(configPath.port)
        .catch(err => console.log(err));
    app.listen(configPath.port);
    console.log(`Server running on ${configPath.url ? configPath.url : 'UNAVAILABLE'} local on port ${configPath.port}...`);
})(app, configPath);


// Database
let DB = {
    products: [{
        id: 'sku42',
        name: 'Meal',
        price: 5.50,
        currency: 'EUR'
    }],
    orders: [{
        itemId: 'sku43',
        quantity: 2,
        amount: 1100,
        currency: 'EUR',
        authorized: true,
        instrumentId: 'd77ef398fae483c5ebf94697584ccbbc57883d845bd87ae7'
    }],
    getProduct: (productId) => DB.products.find(product => product.id === productId),
    createOrder: (order) => DB.orders.push(order),
    getOrder: (id) => DB.orders[id - 1]
};
