
// require('dotenv').config({path: './env'})
// console.log("process.env: ",process.env)

import dotenv from "dotenv"
import connectDb from "./db/index.js"

dotenv.config({
    path: "./.env"
})


connectDb()

// import mongoose, { connect } from "mongoose";
// import { DB_NAME } from "./constants"

/*
import express from "express";

const app = express()

;( async () => {
    try{
       await mongoose.connect(`${process.env.MONGO_URL}/${DB_NAME}`) 

       app.on("error", (err) => {
        console.log("ERROR", err)
        throw err
       })

       app.listen(process.env.PORT, () => {
        console.log(`Server started at PORT ${process.env.PORT}`)
       })

    }catch(error){
        console.log("ERROR", error)
        throw error
    }
})()
    */